/**
 * Reply composer — builds a threaded reply as an RFC 5322 MIME document,
 * matching a mail client's Reply button (Mailbird history_container for HTML).
 *
 * Pure functions, no IMAP/SMTP dependency — fully unit-testable.
 */

import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import type { Account, Email, EmailAddress } from '../types/index.js';
import type { MailAttachment } from '../utils/mail-attachments.js';

export interface ReplyDraftOptions {
  body: string;
  replyAll?: boolean;
  html?: boolean;
  quoteOriginal?: boolean;
  attachments?: MailAttachment[];
}

export interface ReplyDraftMessage {
  raw: Buffer;
  subject: string;
  to: EmailAddress[];
  cc: EmailAddress[];
  references: string[];
  html: boolean;
}

export interface ComposedReplyBodies {
  html?: string;
  text?: string;
}

function formatAddress(addr: EmailAddress | undefined): string {
  if (!addr?.address) return '';
  return addr.name ? `"${addr.name.replace(/"/g, "'")}" <${addr.address}>` : addr.address;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Prefix the subject with "Re:" unless it already carries one (any case). */
export function replySubject(subject: string | undefined): string {
  const base = subject ?? '';
  return /^re:\s*/i.test(base) ? base : `Re: ${base}`;
}

/**
 * Recipients of a reply, mirroring a mail client's Reply / Reply All:
 * Reply-To (or From) goes to To; with replyAll the original To/Cc follow,
 * minus our own address and duplicates. Replying to our own sent message
 * falls back to its original recipients.
 */
export function replyRecipients(
  original: Pick<Email, 'from' | 'to' | 'cc' | 'replyTo'>,
  accountEmail: string,
  replyAll: boolean,
): { to: EmailAddress[]; cc: EmailAddress[] } {
  const self = accountEmail.toLowerCase();
  const seen = new Set<string>();
  const to: EmailAddress[] = [];
  const cc: EmailAddress[] = [];

  const push = (list: EmailAddress[], addr: EmailAddress | undefined, skipSelf: boolean): void => {
    const key = (addr?.address ?? '').toLowerCase();
    if (!addr || !key || seen.has(key) || (skipSelf && key === self)) return;
    seen.add(key);
    list.push(addr);
  };

  const primary = original.replyTo?.length ? original.replyTo : [original.from];
  primary.forEach((addr) => {
    push(to, addr, true);
  });

  if (replyAll) {
    original.to.forEach((addr) => {
      push(to, addr, true);
    });
    (original.cc ?? []).forEach((addr) => {
      push(cc, addr, true);
    });
  }

  if (to.length === 0) {
    original.to.forEach((addr) => {
      push(to, addr, false);
    });
  }
  if (to.length === 0) push(to, original.from, false);

  return { to, cc };
}

/** References chain for the reply: the original's References plus its Message-ID. */
export function replyReferences(original: Pick<Email, 'references' | 'messageId'>): string[] {
  return [...(original.references ?? []), original.messageId].filter(Boolean);
}

/** Mailbird-style attribution: "W dniu DD.MM.YYYY HH:MM:SS, Name <email> pisze:" */
export function attributionLine(original: Pick<Email, 'from' | 'date'>): string {
  const date = new Date(original.date);
  let when = original.date;
  if (!Number.isNaN(date.getTime())) {
    const pad = (n: number): string => String(n).padStart(2, '0');
    when = `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  }
  const who = original.from.name
    ? `${original.from.name} <${original.from.address}>`
    : original.from.address;
  return `W dniu ${when}, ${who} pisze:`;
}

/** Convert plain text into Mailbird-like HTML line blocks (no &lt;pre&gt;). */
export function plainTextToHtml(text: string): string {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\s+$/, '');
  if (normalized.length === 0) return '<div><br></div>';
  return normalized
    .split('\n')
    .map((line) => (line.length > 0 ? `<div>${escapeHtml(line)}</div>` : '<div><br></div>'))
    .join('');
}

/** Strip outer html/head/body wrappers so the fragment embeds cleanly in history. */
export function unwrapHtmlDocument(html: string): string {
  const bodyMatch = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html);
  if (bodyMatch) return bodyMatch[1].trim();
  return html.replace(/<\/?(?:html|head)(?:\s[^>]*)?>/gi, '').trim();
}

/** Plain-text quote of the original message: attribution line + "> " prefixed lines. */
export function quoteOriginalText(
  original: Pick<Email, 'from' | 'date' | 'bodyText' | 'bodyHtml'>,
): string {
  const source =
    original.bodyText ??
    (original.bodyHtml
      ? original.bodyHtml
          .replace(/<br\s*\/?>/gi, '\n')
          .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
          .replace(/<[^>]+>/g, '')
          .replace(/&nbsp;/gi, ' ')
          .replace(/&lt;/gi, '<')
          .replace(/&gt;/gi, '>')
          .replace(/&amp;/gi, '&')
      : '');
  const text = source.replace(/\r\n/g, '\n').replace(/\s+$/, '');
  const lines = text.length > 0 ? text.split('\n') : [];
  return [
    attributionLine(original),
    ...lines.map((line) => (line.length > 0 ? `> ${line}` : '>')),
  ].join('\n');
}

/**
 * Mailbird-compatible history block: class=history_container so the client
 * collapses it under "…", with the original HTML preserved (not flattened to &lt;pre&gt;).
 */
export function quoteOriginalHtml(
  original: Pick<Email, 'from' | 'date' | 'bodyText' | 'bodyHtml'>,
): string {
  const inner = original.bodyHtml
    ? unwrapHtmlDocument(original.bodyHtml)
    : plainTextToHtml(original.bodyText ?? '');
  const attr = escapeHtml(attributionLine(original));
  return [
    '<blockquote class="history_container" type="cite" style="border-left-style:solid;border-width:1px; margin-top:20px; margin-left:0px;padding-left:10px;">',
    `<p style="color: #AAAAAA; margin-top: 10px;">${attr}</p>`,
    `<div style="font-family:Arial,Helvetica,sans-serif">${inner}</div>`,
    '</blockquote>',
  ].join('');
}

/**
 * Compose reply body parts. When quoting, always emit HTML with a Mailbird
 * history_container so mail clients can collapse the thread history; also emit
 * a plain-text alternative. Without quoting, honour the html flag as given.
 */
export function composeReplyBodies(
  original: Email,
  options: ReplyDraftOptions,
): ComposedReplyBodies {
  const quote = options.quoteOriginal !== false;

  if (!quote) {
    return options.html ? { html: options.body } : { text: options.body };
  }

  const replyHtml = options.html ? options.body : plainTextToHtml(options.body);
  const history = quoteOriginalHtml(original);
  return {
    html: `${replyHtml}${history}`,
    text: `${options.html ? options.body.replace(/<[^>]+>/g, '') : options.body}\n\n${quoteOriginalText(original)}`,
  };
}

/**
 * Build the raw MIME reply. Threading headers (In-Reply-To, References),
 * "Re:" subject, recipients and the quoted original are derived from the
 * original message exactly as a mail client's Reply button would do.
 */
export async function buildReplyDraft(
  account: Account,
  original: Email,
  options: ReplyDraftOptions,
): Promise<ReplyDraftMessage> {
  const { to, cc } = replyRecipients(original, account.email, options.replyAll === true);
  const subject = replySubject(original.subject);
  const references = replyReferences(original);
  const bodies = composeReplyBodies(original, options);
  const useHtml = bodies.html !== undefined;

  const mail = new MailComposer({
    from: formatAddress({ name: account.fullName ?? '', address: account.email }),
    to: to.map(formatAddress).join(', '),
    cc: cc.length > 0 ? cc.map(formatAddress).join(', ') : undefined,
    subject,
    inReplyTo: original.messageId || undefined,
    references: references.length > 0 ? references.join(' ') : undefined,
    attachments: options.attachments,
    ...(useHtml
      ? { html: bodies.html, ...(bodies.text ? { text: bodies.text } : {}) }
      : { text: bodies.text }),
  });

  const raw = await mail.compile().build();
  return { raw, subject, to, cc, references, html: useHtml };
}
