/**
 * SMTP service — pure business logic for email send operations.
 *
 * No MCP dependency — fully unit-testable.
 */

import { randomUUID } from 'node:crypto';
import type { IConnectionManager } from '../connections/types.js';
import type RateLimiter from '../safety/rate-limiter.js';
import type { AccountConfig, SendResult } from '../types/index.js';
import { buildRawMessage } from '../utils/mail-message.js';
import type ImapService from './imap.service.js';

interface OutgoingMailFields {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text?: string;
  html?: string;
  inReplyTo?: string;
  references?: string;
}

export default class SmtpService {
  constructor(
    private connections: IConnectionManager,
    private rateLimiter: RateLimiter,
    private imapService: ImapService,
  ) {}

  // -------------------------------------------------------------------------
  // Send email
  // -------------------------------------------------------------------------

  async sendEmail(
    accountName: string,
    options: {
      to: string[];
      subject: string;
      body: string;
      cc?: string[];
      bcc?: string[];
      html?: boolean;
    },
  ): Promise<SendResult> {
    this.checkRateLimit(accountName);
    const account = this.connections.getAccount(accountName);

    return this.composeSendAndArchive(accountName, account, {
      to: options.to,
      cc: options.cc,
      bcc: options.bcc,
      subject: options.subject,
      ...(options.html ? { html: options.body } : { text: options.body }),
    });
  }

  // -------------------------------------------------------------------------
  // Reply
  // -------------------------------------------------------------------------

  async replyToEmail(
    accountName: string,
    options: {
      emailId: string;
      mailbox?: string;
      body: string;
      replyAll?: boolean;
      html?: boolean;
    },
  ): Promise<SendResult> {
    this.checkRateLimit(accountName);

    const account = this.connections.getAccount(accountName);
    const original = await this.imapService.getEmail(accountName, options.emailId, options.mailbox);

    // Build recipient list
    const to = [original.from.address];
    const cc: string[] = [];

    if (options.replyAll) {
      // Add all original To recipients except ourselves
      original.to
        .filter((addr) => addr.address !== account.email)
        .forEach((addr) => {
          to.push(addr.address);
        });
      // Add CC recipients except ourselves
      (original.cc ?? [])
        .filter((addr) => addr.address !== account.email)
        .forEach((addr) => {
          cc.push(addr.address);
        });
    }

    // Build threading headers
    const references = [...(original.references ?? []), original.messageId].filter(Boolean);

    const subject = original.subject.startsWith('Re:')
      ? original.subject
      : `Re: ${original.subject}`;

    return this.composeSendAndArchive(accountName, account, {
      to,
      cc: cc.length > 0 ? cc : undefined,
      subject,
      inReplyTo: original.messageId,
      references: references.join(' '),
      ...(options.html ? { html: options.body } : { text: options.body }),
    });
  }

  // -------------------------------------------------------------------------
  // Forward
  // -------------------------------------------------------------------------

  async forwardEmail(
    accountName: string,
    options: {
      emailId: string;
      mailbox?: string;
      to: string[];
      body?: string;
      cc?: string[];
    },
  ): Promise<SendResult> {
    this.checkRateLimit(accountName);

    const account = this.connections.getAccount(accountName);
    const original = await this.imapService.getEmail(accountName, options.emailId, options.mailbox);

    const subject = original.subject.startsWith('Fwd:')
      ? original.subject
      : `Fwd: ${original.subject}`;

    // Build forwarded message body
    const forwardHeader = [
      '',
      '---------- Forwarded message ----------',
      `From: ${original.from.name ? `${original.from.name} <${original.from.address}>` : original.from.address}`,
      `Date: ${original.date}`,
      `Subject: ${original.subject}`,
      `To: ${original.to.map((a) => a.address).join(', ')}`,
      '',
    ].join('\n');

    const originalBody = original.bodyText ?? original.bodyHtml ?? '';
    const fullBody = (options.body ?? '') + forwardHeader + originalBody;

    return this.composeSendAndArchive(accountName, account, {
      to: options.to,
      cc: options.cc,
      subject,
      text: fullBody,
    });
  }

  // -------------------------------------------------------------------------
  // Rate limit check
  // -------------------------------------------------------------------------

  private checkRateLimit(accountName: string): void {
    if (!this.rateLimiter.tryConsume(accountName)) {
      throw new Error(
        `Rate limit exceeded for account "${accountName}". ` +
          `Please wait before sending more emails.`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Send draft
  // -------------------------------------------------------------------------

  async sendDraft(accountName: string, draftId: number, mailbox?: string): Promise<SendResult> {
    this.checkRateLimit(accountName);

    // Fetch the draft via IMAP
    const { email: draft, mailbox: draftsPath } = await this.imapService.fetchDraft(
      accountName,
      draftId,
      mailbox,
    );

    const account = this.connections.getAccount(accountName);

    const result = await this.composeSendAndArchive(accountName, account, {
      to: draft.to.map((a) => a.address),
      cc: draft.cc?.map((a) => a.address),
      bcc: draft.bcc?.map((a) => a.address),
      subject: draft.subject,
      inReplyTo: draft.inReplyTo,
      references: draft.references?.join(' '),
      ...(draft.bodyHtml ? { html: draft.bodyHtml } : { text: draft.bodyText ?? '' }),
    });

    // Delete the draft after successful send
    await this.imapService.deleteDraft(accountName, draftId, draftsPath);

    return result;
  }

  // -------------------------------------------------------------------------
  // Compose once, send over SMTP, then archive the exact same bytes to Sent
  // -------------------------------------------------------------------------

  /**
   * Builds the raw MIME message once, sends those exact bytes over SMTP,
   * then IMAP-appends the same bytes to the account's Sent mailbox.
   *
   * The Sent-mailbox copy is best-effort: the mail has already been
   * accepted by SMTP by the time we attempt it, so a failure there is
   * reported as a warning on the result rather than thrown.
   */
  private async composeSendAndArchive(
    accountName: string,
    account: AccountConfig,
    fields: OutgoingMailFields,
  ): Promise<SendResult> {
    const transport = await this.connections.getSmtpTransport(accountName);

    const domain = account.email.split('@')[1] ?? 'localhost';
    const messageId = `<${randomUUID()}@${domain}>`;
    const from = account.fullName ? `"${account.fullName}" <${account.email}>` : account.email;

    const raw = await buildRawMessage({
      from,
      to: fields.to.join(', '),
      cc: fields.cc?.length ? fields.cc.join(', ') : undefined,
      bcc: fields.bcc?.length ? fields.bcc.join(', ') : undefined,
      subject: fields.subject,
      text: fields.text,
      html: fields.html,
      inReplyTo: fields.inReplyTo,
      references: fields.references,
      messageId,
    });

    const envelope = {
      from: account.email,
      to: [...fields.to, ...(fields.cc ?? []), ...(fields.bcc ?? [])],
    };

    await transport.sendMail({ raw, envelope });

    const result: SendResult = { messageId, status: 'sent' };

    try {
      const { mailbox } = await this.imapService.appendToSent(accountName, raw);
      result.sentCopy = { saved: true, mailbox };
    } catch (err) {
      result.sentCopy = {
        saved: false,
        warning: `Could not save a copy to Sent: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    return result;
  }
}
