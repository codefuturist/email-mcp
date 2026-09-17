/**
 * SMTP service — pure business logic for email send operations.
 *
 * No MCP dependency — fully unit-testable.
 */

import type { IConnectionManager } from '../connections/types.js';
import type RateLimiter from '../safety/rate-limiter.js';
import { MAX_ATTACHMENT_SIZE, validateAttachments } from '../safety/validation.js';
import type { AttachmentInput, SendResult } from '../types/index.js';
import { resolveAttachments } from '../utils/mail-attachments.js';
import type ImapService from './imap.service.js';
import {
  composeReplyBodies,
  replyRecipients,
  replyReferences,
  replySubject,
} from './reply-draft.js';

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
      attachments?: AttachmentInput[];
    },
  ): Promise<SendResult> {
    this.checkRateLimit(accountName);
    await validateAttachments(options.attachments);

    const account = this.connections.getAccount(accountName);
    const transport = await this.connections.getSmtpTransport(accountName);
    const attachments = await resolveAttachments(options.attachments);

    const result = await transport.sendMail({
      from: account.fullName ? `"${account.fullName}" <${account.email}>` : account.email,
      to: options.to.join(', '),
      cc: options.cc?.join(', '),
      bcc: options.bcc?.join(', '),
      subject: options.subject,
      attachments,
      ...(options.html ? { html: options.body } : { text: options.body }),
    });

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
      quoteOriginal?: boolean;
      attachments?: AttachmentInput[];
    },
  ): Promise<SendResult> {
    this.checkRateLimit(accountName);
    await validateAttachments(options.attachments);

    const account = this.connections.getAccount(accountName);
    const original = await this.imapService.getEmail(accountName, options.emailId, options.mailbox);

    const { to, cc } = replyRecipients(original, account.email, options.replyAll === true);
    const references = replyReferences(original);
    const subject = replySubject(original.subject);
    const bodies = composeReplyBodies(original, {
      body: options.body,
      html: options.html,
      quoteOriginal: options.quoteOriginal,
    });
    const attachments = await resolveAttachments(options.attachments);

    const transport = await this.connections.getSmtpTransport(accountName);

    const result = await transport.sendMail({
      from: account.fullName ? `"${account.fullName}" <${account.email}>` : account.email,
      to: to.map((a) => a.address).join(', '),
      cc: cc.length > 0 ? cc.map((a) => a.address).join(', ') : undefined,
      subject,
      inReplyTo: original.messageId,
      references: references.join(' '),
      attachments,
      ...(bodies.html
        ? { html: bodies.html, ...(bodies.text ? { text: bodies.text } : {}) }
        : { text: bodies.text }),
    });

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
      attachments?: AttachmentInput[];
      includeOriginalAttachments?: boolean;
    },
  ): Promise<SendResult> {
    this.checkRateLimit(accountName);
    await validateAttachments(options.attachments);

    const account = this.connections.getAccount(accountName);
    const original = await this.imapService.getEmail(accountName, options.emailId, options.mailbox);

    const subject = original.subject.startsWith('Fwd:')
      ? original.subject
      : `Fwd: ${original.subject}`;

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

    const userAttachments = (await resolveAttachments(options.attachments)) ?? [];
    const originalAttachments = [];
    if (options.includeOriginalAttachments && original.attachments.length > 0) {
      const totalOriginalSize = original.attachments.reduce((sum, a) => sum + a.size, 0);
      if (totalOriginalSize > MAX_ATTACHMENT_SIZE) {
        throw new Error(
          `Original email's attachments (${Math.round(totalOriginalSize / 1024 / 1024)}MB) exceed the ${MAX_ATTACHMENT_SIZE / 1024 / 1024}MB per-file limit; forward without includeOriginalAttachments and attach selectively instead`,
        );
      }
      originalAttachments.push(
        ...(await Promise.all(
          original.attachments.map(async (meta) => {
            const downloaded = await this.imapService.downloadAttachment(
              accountName,
              options.emailId,
              options.mailbox ?? 'INBOX',
              meta.filename,
              MAX_ATTACHMENT_SIZE,
            );
            return {
              filename: downloaded.filename,
              content: Buffer.from(downloaded.contentBase64, 'base64'),
              contentType: downloaded.mimeType,
            };
          }),
        )),
      );
    }

    const transport = await this.connections.getSmtpTransport(accountName);

    const result = await transport.sendMail({
      from: account.fullName ? `"${account.fullName}" <${account.email}>` : account.email,
      to: options.to.join(', '),
      cc: options.cc?.join(', '),
      subject,
      text: fullBody,
      attachments: [...originalAttachments, ...userAttachments],
    });

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

    const { email: draft, mailbox: draftsPath } = await this.imapService.fetchDraft(
      accountName,
      draftId,
      mailbox,
    );

    const account = this.connections.getAccount(accountName);
    const transport = await this.connections.getSmtpTransport(accountName);

    const to = draft.to.map((a) => a.address).join(', ');
    const cc = draft.cc?.map((a) => a.address).join(', ');

    const attachments = await Promise.all(
      draft.attachments.map(async (meta) => {
        const downloaded = await this.imapService.downloadAttachment(
          accountName,
          String(draftId),
          draftsPath,
          meta.filename,
          MAX_ATTACHMENT_SIZE,
        );
        return {
          filename: downloaded.filename,
          content: Buffer.from(downloaded.contentBase64, 'base64'),
          contentType: downloaded.mimeType,
        };
      }),
    );

    const result = await transport.sendMail({
      from: account.fullName ? `"${account.fullName}" <${account.email}>` : account.email,
      to,
      cc,
      subject: draft.subject,
      inReplyTo: draft.inReplyTo,
      references: draft.references?.join(' '),
      attachments,
      ...(draft.bodyHtml ? { html: draft.bodyHtml } : { text: draft.bodyText ?? '' }),
    });

    await this.imapService.deleteDraft(accountName, draftId, draftsPath);

    return {
      messageId: result.messageId ?? '',
      status: 'sent',
    };
  }
}
