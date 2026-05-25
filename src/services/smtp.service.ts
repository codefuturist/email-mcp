/**
 * SMTP service — pure business logic for email send operations.
 *
 * No MCP dependency — fully unit-testable.
 */

import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import type { IConnectionManager } from '../connections/types.js';
import type RateLimiter from '../safety/rate-limiter.js';
import type { SendResult } from '../types/index.js';
import type ImapService from './imap.service.js';

type MailOptions = Record<string, unknown>;

/** Build the raw RFC822 bytes for a message via nodemailer's MailComposer. */
async function buildRaw(mailOptions: MailOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const composer = new (MailComposer as any)(mailOptions);
    composer.compile().build((err: Error | null, raw: Buffer) => {
      if (err) reject(err);
      else resolve(raw);
    });
  });
}

/** Generate a Message-ID in the standard `<random@host>` form. */
function generateMessageId(fromEmail: string): string {
  const domain = fromEmail.split('@')[1] ?? 'localhost';
  const rnd = Math.random().toString(36).slice(2) + Date.now().toString(36);
  return `<${rnd}@${domain}>`;
}

export default class SmtpService {
  constructor(
    private connections: IConnectionManager,
    private rateLimiter: RateLimiter,
    private imapService: ImapService,
  ) {}

  // -------------------------------------------------------------------------
  // Internal: send via SMTP, then APPEND to Sent if enabled for the account
  // -------------------------------------------------------------------------

  private async dispatch(accountName: string, mailOptions: MailOptions): Promise<SendResult> {
    const account = this.connections.getAccount(accountName);
    const transport = await this.connections.getSmtpTransport(accountName);

    // Pin Message-ID and Date so the SMTP-sent message and the IMAP-APPENDed
    // copy carry identical threading-critical headers.
    const messageId =
      typeof mailOptions.messageId === 'string'
        ? mailOptions.messageId
        : generateMessageId(account.email);
    const date = mailOptions.date instanceof Date ? mailOptions.date : new Date();

    const finalOptions: MailOptions = {
      ...mailOptions,
      messageId,
      date,
    };

    const info = await transport.sendMail(finalOptions);

    // Best-effort save to Sent — never let a Sent-save failure block the send.
    if (account.saveToSent) {
      try {
        const raw = await buildRaw(finalOptions);
        await this.imapService.saveToSent(accountName, raw, date);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        // eslint-disable-next-line no-console
        console.error(
          `[email-mcp] save_to_sent: APPEND to Sent folder failed for ` +
            `account "${accountName}": ${errMsg}`,
        );
      }
    }

    return {
      messageId: typeof info.messageId === 'string' && info.messageId ? info.messageId : messageId,
      status: 'sent',
    };
  }

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

    return this.dispatch(accountName, {
      from: account.fullName ? `"${account.fullName}" <${account.email}>` : account.email,
      to: options.to.join(', '),
      cc: options.cc?.join(', '),
      bcc: options.bcc?.join(', '),
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

    return this.dispatch(accountName, {
      from: account.fullName ? `"${account.fullName}" <${account.email}>` : account.email,
      to: to.join(', '),
      cc: cc.length > 0 ? cc.join(', ') : undefined,
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

    return this.dispatch(accountName, {
      from: account.fullName ? `"${account.fullName}" <${account.email}>` : account.email,
      to: options.to.join(', '),
      cc: options.cc?.join(', '),
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

    const to = draft.to.map((a) => a.address).join(', ');
    const cc = draft.cc?.map((a) => a.address).join(', ');

    const result = await this.dispatch(accountName, {
      from: account.fullName ? `"${account.fullName}" <${account.email}>` : account.email,
      to,
      cc,
      subject: draft.subject,
      inReplyTo: draft.inReplyTo,
      references: draft.references?.join(' '),
      ...(draft.bodyHtml ? { html: draft.bodyHtml } : { text: draft.bodyText ?? '' }),
    });

    // Delete the draft after successful send
    await this.imapService.deleteDraft(accountName, draftId, draftsPath);

    return result;
  }
}
