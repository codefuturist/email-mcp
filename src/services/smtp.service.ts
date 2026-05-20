/**
 * SMTP service — pure business logic for email send operations.
 *
 * No MCP dependency — fully unit-testable.
 */

import type { IConnectionManager } from '../connections/types.js';
import type RateLimiter from '../safety/rate-limiter.js';
import type { SendResult } from '../types/index.js';
import type ImapService from './imap.service.js';

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
    const transport = await this.connections.getSmtpTransport(accountName);

    const fromAddress = account.fullName
      ? `"${account.fullName}" <${account.email}>`
      : account.email;

    const result = await transport.sendMail({
      from: fromAddress,
      to: options.to.join(', '),
      cc: options.cc?.join(', '),
      bcc: options.bcc?.join(', '),
      subject: options.subject,
      ...(options.html ? { html: options.body } : { text: options.body }),
    });

    // Append to Sent folder
    try {
      await this.imapService.saveToSent(accountName, {
        from: fromAddress,
        to: options.to,
        subject: options.subject,
        body: options.body,
        messageId: result.messageId,
        cc: options.cc,
        bcc: options.bcc,
        html: options.html,
      });
    } catch {
      // Don't fail the send if Sent folder append fails
    }

    return {
      messageId: result.messageId ?? '',
      status: 'sent',
    };
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

    const transport = await this.connections.getSmtpTransport(accountName);
    const fromAddress = account.fullName
      ? `"${account.fullName}" <${account.email}>`
      : account.email;

    const result = await transport.sendMail({
      from: fromAddress,
      to: to.join(', '),
      cc: cc.length > 0 ? cc.join(', ') : undefined,
      subject,
      inReplyTo: original.messageId,
      references: references.join(' '),
      ...(options.html ? { html: options.body } : { text: options.body }),
    });

    // Append to Sent folder
    try {
      await this.imapService.saveToSent(accountName, {
        from: fromAddress,
        to,
        subject,
        body: options.body,
        messageId: result.messageId,
        cc: cc.length > 0 ? cc : undefined,
        html: options.html,
        inReplyTo: original.messageId,
        references: references.join(' '),
      });
    } catch {
      // Don't fail the send if Sent folder append fails
    }

    return {
      messageId: result.messageId ?? '',
      status: 'sent',
    };
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

    const transport = await this.connections.getSmtpTransport(accountName);
    const fromAddress = account.fullName
      ? `"${account.fullName}" <${account.email}>`
      : account.email;

    const result = await transport.sendMail({
      from: fromAddress,
      to: options.to.join(', '),
      cc: options.cc?.join(', '),
      subject,
      text: fullBody,
    });

    // Append to Sent folder
    try {
      await this.imapService.saveToSent(accountName, {
        from: fromAddress,
        to: options.to,
        subject,
        body: fullBody,
        messageId: result.messageId,
        cc: options.cc,
      });
    } catch {
      // Don't fail the send if Sent folder append fails
    }

    return {
      messageId: result.messageId ?? '',
      status: 'sent',
    };
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
    const transport = await this.connections.getSmtpTransport(accountName);
    const fromAddress = account.fullName
      ? `"${account.fullName}" <${account.email}>`
      : account.email;

    const toAddrs = draft.to.map((a) => a.address);
    const ccAddrs = draft.cc?.map((a) => a.address);
    const to = toAddrs.join(', ');
    const cc = ccAddrs?.join(', ');
    const bodyContent = draft.bodyText ?? draft.bodyHtml ?? '';
    const isHtml = !draft.bodyText && !!draft.bodyHtml;

    const result = await transport.sendMail({
      from: fromAddress,
      to,
      cc,
      subject: draft.subject,
      inReplyTo: draft.inReplyTo,
      references: draft.references?.join(' '),
      ...(isHtml ? { html: bodyContent } : { text: bodyContent }),
    });

    // Append to Sent folder
    try {
      await this.imapService.saveToSent(accountName, {
        from: fromAddress,
        to: toAddrs,
        subject: draft.subject,
        body: bodyContent,
        messageId: result.messageId,
        cc: ccAddrs,
        html: isHtml,
        inReplyTo: draft.inReplyTo,
        references: draft.references?.join(' '),
      });
    } catch {
      // Don't fail the send if Sent folder append fails
    }

    // Delete the draft after successful send
    await this.imapService.deleteDraft(accountName, draftId, draftsPath);

    return {
      messageId: result.messageId ?? '',
      status: 'sent',
    };
  }
}
