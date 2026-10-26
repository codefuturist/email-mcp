/**
 * SMTP service — pure business logic for email send operations.
 *
 * No MCP dependency — fully unit-testable.
 */

import MailComposer from 'nodemailer/lib/mail-composer/index.js';

import type { IConnectionManager } from '../connections/types.js';
import { mcpLog } from '../logging.js';
import type RateLimiter from '../safety/rate-limiter.js';
import { sanitizeTemplateVariable } from '../safety/validation.js';
import type { SendResult, SentCopyResult } from '../types/index.js';
import { stripHtml } from '../utils/html.js';
import { quoteOriginalAsHtml, quoteOriginalAsText } from '../utils/quote.js';
import type { PreparedAttachment } from './attachments.js';
import type ImapService from './imap.service.js';

/** Per-file ceiling when re-fetching originals for a forward. */
const FORWARD_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;

/**
 * Narrow a prepared attachment to what nodemailer needs. A cid moves the file
 * into multipart/related beside the HTML part, so it must ship as inline —
 * as a classic attachment it would show up as a stray file instead of
 * rendering where the <img src="cid:..."> points.
 */
function toTransportAttachment({ filename, path, cid, contentType }: PreparedAttachment): {
  filename: string;
  path: string;
  cid?: string;
  contentDisposition?: 'inline';
  contentType?: string;
} {
  return {
    filename,
    path,
    ...(cid ? { cid, contentDisposition: 'inline' as const } : {}),
    ...(contentType ? { contentType } : {}),
  };
}

export default class SmtpService {
  private readonly saveToSent: boolean;

  constructor(
    private connections: IConnectionManager,
    private rateLimiter: RateLimiter,
    private imapService: ImapService,
    options: { saveToSent?: boolean } = {},
  ) {
    this.saveToSent = options.saveToSent ?? false;
  }

  /**
   * File a copy of a just-sent message in the Sent folder.
   *
   * SMTP delivers; it files nothing. This is opt-in (`saveToSent`) — and
   * `ImapService.appendToSent` itself skips accounts Gmail already files
   * sent mail for, since doing it anyway would give those users two copies.
   *
   * The copy is composed from the same mail options that were just sent,
   * carrying the Message-ID the transport reported, so a later reply threads
   * against the message that actually went out. It is deliberately NOT sent as
   * `raw`: nodemailer does not derive an envelope from raw headers (it reports
   * `{from: false, to: []}`), so composing once and sending the bytes would
   * put recipient resolution — the single most dangerous thing in this file —
   * on an untested path. The bytes therefore differ from the wire copy only in
   * MIME boundary strings, which no reader cares about.
   *
   * Never throws. The mail has already left; reporting a failure here would
   * tell the user the send failed and invite a duplicate send. The outcome is
   * returned instead, so callers can tell a failure from an intentional skip.
   */
  private async fileCopyInSent(
    accountName: string,
    mail: Record<string, unknown>,
    messageId: string | undefined,
  ): Promise<SentCopyResult> {
    if (!this.saveToSent) return { kind: 'skipped' };

    let result: SentCopyResult;
    try {
      const raw = await new MailComposer({ ...mail, ...(messageId ? { messageId } : {}) })
        .compile()
        .build();
      result = await this.imapService.appendToSent(accountName, raw);
    } catch (err) {
      result = { kind: 'failed', error: err instanceof Error ? err.message : String(err) };
    }

    if (result.kind === 'failed') {
      await mcpLog(
        'warning',
        'smtp',
        `sent, but could not file a copy in the Sent folder: ${result.error}`,
      );
    }
    return result;
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
      attachments?: PreparedAttachment[];
      /** Threading headers — a scheduled reply keeps its place in the thread. */
      inReplyTo?: string;
      references?: string[];
    },
  ): Promise<SendResult> {
    this.checkRateLimit(accountName);

    const account = this.connections.getAccount(accountName);
    const transport = await this.connections.getSmtpTransport(accountName);

    const mail = {
      from: account.fullName ? `"${account.fullName}" <${account.email}>` : account.email,
      to: options.to.join(', '),
      cc: options.cc?.join(', '),
      bcc: options.bcc?.join(', '),
      subject: options.subject,
      ...(options.inReplyTo ? { inReplyTo: options.inReplyTo } : {}),
      ...(options.references?.length ? { references: options.references.join(' ') } : {}),
      // nodemailer 10 removed text:'auto' — generate the plain alternative
      // here so HTML mail goes out as multipart/alternative, not single-part.
      ...(options.html
        ? { html: options.body, text: stripHtml(options.body) }
        : { text: options.body }),
      ...(options.attachments?.length
        ? { attachments: options.attachments.map(toTransportAttachment) }
        : {}),
    };

    const result = await transport.sendMail(mail);
    const sentCopy = await this.fileCopyInSent(accountName, mail, result.messageId);

    return {
      messageId: result.messageId ?? '',
      status: 'sent',
      sentCopy,
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
      attachments?: PreparedAttachment[];
      /**
       * When true (default), the original message is appended below the reply
       * as a quoted block (Thunderbird/Outlook style: "On DATE, NAME wrote:"
       * followed by `>`-prefixed lines, or `<blockquote type="cite">` for HTML
       * replies). Set false to send the bare reply body only.
       */
      quoteOriginal?: boolean;
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

    // Appended below the reply unless explicitly disabled — the same
    // convention every desktop client (Thunderbird, Outlook, Apple Mail)
    // applies automatically. In the HTML case the plain-text alternative
    // comes from stripHtml, which already turns a <blockquote> into "> "
    // lines, so only the HTML body needs the quote appended.
    const includeQuote = options.quoteOriginal !== false;
    const htmlBody = options.html
      ? options.body + (includeQuote ? quoteOriginalAsHtml(original) : '')
      : undefined;
    const textBody = options.html
      ? undefined
      : options.body + (includeQuote ? quoteOriginalAsText(original) : '');

    const transport = await this.connections.getSmtpTransport(accountName);

    const mail = {
      from: account.fullName ? `"${account.fullName}" <${account.email}>` : account.email,
      to: to.join(', '),
      cc: cc.length > 0 ? cc.join(', ') : undefined,
      subject,
      inReplyTo: original.messageId,
      references: references.join(' '),
      ...(htmlBody !== undefined
        ? { html: htmlBody, text: stripHtml(htmlBody) }
        : { text: textBody }),
      ...(options.attachments?.length
        ? { attachments: options.attachments.map(toTransportAttachment) }
        : {}),
    };

    const result = await transport.sendMail(mail);
    const sentCopy = await this.fileCopyInSent(accountName, mail, result.messageId);

    return {
      messageId: result.messageId ?? '',
      status: 'sent',
      sentCopy,
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
      includeAttachments?: boolean;
      html?: boolean;
    },
  ): Promise<SendResult> {
    this.checkRateLimit(accountName);

    const account = this.connections.getAccount(accountName);
    const original = await this.imapService.getEmail(accountName, options.emailId, options.mailbox);

    // Carry the original's attachments unless explicitly declined -- a forward
    // that silently strips them misrepresents the original message.
    //
    // What "inline" means here depends on whether the original HTML actually
    // embeds the part. A part its <img src="cid:..."> points at is layout: it
    // travels along, still inline, when the HTML does (otherwise the images
    // break), and is dropped when the forward is plain text because nothing
    // references it. An inline part nothing embeds is a real file the sender
    // attached — Apple Mail ships user-inserted photos as `inline; filename=`
    // — so it forwards like any other attachment.
    const embedded = (contentId: string | undefined): boolean =>
      contentId !== undefined && (original.bodyHtml?.includes(`cid:${contentId}`) ?? false);

    const attachments: {
      filename: string;
      content: Buffer;
      contentType: string;
      cid?: string;
      contentDisposition?: 'inline';
    }[] = [];
    const forwardable = (original.attachments ?? []).filter(
      (a) => !embedded(a.contentId) || options.html === true,
    );
    if (options.includeAttachments !== false && forwardable.length) {
      for (const meta of forwardable) {
        const dl = await this.imapService.downloadAttachment(
          accountName,
          options.emailId,
          options.mailbox ?? 'INBOX',
          meta.partId !== undefined ? { partId: meta.partId } : meta.filename,
          FORWARD_ATTACHMENT_MAX_BYTES,
        );
        const keepsEmbedding = embedded(meta.contentId);
        attachments.push({
          filename: dl.filename,
          content: Buffer.from(dl.contentBase64, 'base64'),
          contentType: dl.mimeType,
          ...(keepsEmbedding && meta.contentId
            ? { cid: meta.contentId, contentDisposition: 'inline' as const }
            : {}),
        });
      }
    }

    // Envelope fields arrive RFC 2047-decoded with no newline stripping, and
    // the forward header block below is NOT "> "-quoted — so a crafted
    // subject or display name could forge a "From:" line a reader would take
    // as genuine. Collapse any line break before interpolating.
    const oneLine = (value: string): string => value.replace(/[\r\n]+/g, ' ').trim();

    const subject = original.subject.startsWith('Fwd:')
      ? oneLine(original.subject)
      : `Fwd: ${oneLine(original.subject)}`;

    // Build forwarded message body
    const forwardHeader = [
      '',
      '---------- Forwarded message ----------',
      `From: ${original.from.name ? `${oneLine(original.from.name)} <${oneLine(original.from.address)}>` : oneLine(original.from.address)}`,
      `Date: ${oneLine(original.date)}`,
      `Subject: ${oneLine(original.subject)}`,
      `To: ${original.to.map((a) => oneLine(a.address)).join(', ')}`,
      '',
    ].join('\n');

    // The common case is an HTML-only original — raw markup in a text/plain
    // part is unreadable, so the original is converted and "> "-quoted. The
    // forward header stays unquoted: it is this message's text, not theirs.
    const originalText =
      original.bodyText ?? (original.bodyHtml ? stripHtml(original.bodyHtml) : '');
    const quotedOriginal = originalText
      .split('\n')
      .map((line) => (line.trim() ? `> ${line}` : '>'))
      .join('\n');
    const textBody = (options.body ?? '') + forwardHeader + quotedOriginal;

    let htmlBody: string | undefined;
    if (options.html) {
      const esc = (s: string) => sanitizeTemplateVariable(s, true);
      const note = options.body ? `<p>${esc(options.body).replace(/\n/g, '<br>')}</p>` : '';
      const headerHtml = forwardHeader.trim().split('\n').map(esc).join('<br>');
      const originalHtml =
        original.bodyHtml ?? (originalText ? `<pre>${esc(originalText)}</pre>` : '');
      htmlBody =
        `${note}<div>${headerHtml}</div>` +
        `<blockquote style="border-left:2px solid #ccc;margin:0 0 0 8px;padding-left:8px">${originalHtml}</blockquote>`;
    }

    const transport = await this.connections.getSmtpTransport(accountName);

    const mail = {
      from: account.fullName ? `"${account.fullName}" <${account.email}>` : account.email,
      to: options.to.join(', '),
      cc: options.cc?.join(', '),
      subject,
      text: textBody,
      ...(htmlBody ? { html: htmlBody } : {}),
      ...(attachments.length ? { attachments } : {}),
    };

    const result = await transport.sendMail(mail);
    const sentCopy = await this.fileCopyInSent(accountName, mail, result.messageId);

    return {
      messageId: result.messageId ?? '',
      status: 'sent',
      sentCopy,
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

    const to = draft.to.map((a) => a.address).join(', ');
    const cc = draft.cc?.map((a) => a.address).join(', ');
    const bcc = draft.bcc?.map((a) => a.address).join(', ');
    // Resolve every part before SMTP: never send a silently incomplete draft.
    // Bound the aggregate as well as each part to avoid retaining an unbounded
    // number of buffers while composing the message.
    const attachments = [];
    let remainingBytes = FORWARD_ATTACHMENT_MAX_BYTES;
    for (const meta of draft.attachments ?? []) {
      const part = await this.imapService.downloadAttachment(
        accountName,
        String(draftId),
        draftsPath,
        meta.partId !== undefined ? { partId: meta.partId } : meta.filename,
        remainingBytes,
      );
      const content = Buffer.from(part.contentBase64, 'base64');
      remainingBytes -= content.length;
      if (remainingBytes < 0) throw new Error('Draft attachments exceed the 25 MB limit');
      attachments.push({
        filename: part.filename,
        content,
        contentType: part.mimeType,
        ...(meta.contentId ? { cid: meta.contentId } : {}),
        contentDisposition: meta.inline ? ('inline' as const) : ('attachment' as const),
      });
    }

    const mail = {
      from: account.fullName ? `"${account.fullName}" <${account.email}>` : account.email,
      to,
      cc,
      bcc,
      ...(attachments.length ? { attachments } : {}),
      subject: draft.subject,
      inReplyTo: draft.inReplyTo,
      references: draft.references?.join(' '),
      ...(draft.bodyHtml
        ? { html: draft.bodyHtml, text: draft.bodyText ?? stripHtml(draft.bodyHtml) }
        : { text: draft.bodyText ?? '' }),
    };

    const result = await transport.sendMail(mail);
    const sentCopy = await this.fileCopyInSent(accountName, mail, result.messageId);

    // Delete the draft after a successful send — unless the Sent-copy APPEND
    // failed. The copy would otherwise disappear entirely: the draft gone,
    // and no replacement filed to take its place. A copy that was skipped on
    // purpose (saveToSent off, or Gmail already filing it) is not this case.
    let draftCleanup: SendResult['draftCleanup'] = { kind: 'kept' };
    if (sentCopy.kind !== 'failed') {
      try {
        await this.imapService.deleteDraft(accountName, draftId, draftsPath);
        draftCleanup = { kind: 'removed' };
      } catch (err) {
        // SMTP already accepted the message. Reporting a failed send invites
        // a retry that delivers a duplicate.
        draftCleanup = { kind: 'failed', error: err instanceof Error ? err.message : String(err) };
      }
    }

    return {
      messageId: result.messageId ?? '',
      status: 'sent',
      sentCopy,
      draftCleanup,
    };
  }
}
