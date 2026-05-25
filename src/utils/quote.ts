/**
 * Reply-quoting helpers — produce the "On <date>, <sender> wrote:" block
 * + quoted original body that desktop clients (Thunderbird, Apple Mail,
 * Outlook) automatically prepend to outgoing replies.
 *
 * Without this, replies sent through the MCP show up to the recipient as
 * bare text with no context — they have to dig into the prior thread to
 * understand what's being answered.
 */

import type { Email, EmailAddress } from '../types/index.js';

/** Minimal HTML stripper for converting an HTML original into plain text. */
function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Escape user-controlled text for safe HTML embedding. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatSender(addr: EmailAddress): string {
  return addr.name ? `${addr.name} <${addr.address}>` : addr.address;
}

/**
 * Produce a plain-text quoted block for a reply (Thunderbird/Mutt style):
 *
 *     On <date>, <sender> wrote:
 *     > line 1
 *     > line 2
 */
export function quoteOriginalAsText(original: Email): string {
  const attribution = `On ${original.date}, ${formatSender(original.from)} wrote:`;
  const body = original.bodyText ?? (original.bodyHtml ? stripHtml(original.bodyHtml) : '');
  const quoted = body
    .split('\n')
    .map((line) => (line.length > 0 ? `> ${line}` : '>'))
    .join('\n');
  return `\n\n${attribution}\n${quoted}`;
}

/**
 * Produce an HTML quoted block for an HTML reply, wrapped in the standard
 * `<blockquote type="cite">` that mail clients recognize as quoted material.
 */
export function quoteOriginalAsHtml(original: Email): string {
  const attribution = `On ${escapeHtml(original.date)}, ${escapeHtml(formatSender(original.from))} wrote:`;
  let inner: string;
  if (original.bodyHtml) {
    inner = original.bodyHtml;
  } else if (original.bodyText) {
    inner = `<pre style="white-space:pre-wrap;font-family:inherit;margin:0">${escapeHtml(original.bodyText)}</pre>`;
  } else {
    inner = '';
  }
  return (
    `<br><br>${attribution}<br>` +
    `<blockquote type="cite" style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">${
      inner
    }</blockquote>`
  );
}
