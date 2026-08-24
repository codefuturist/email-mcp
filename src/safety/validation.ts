/** Input validation and sanitization utilities. */

import type { AttachmentInput } from '../types/index.js';

/** Maximum number of attachments allowed on a single outgoing email. */
export const MAX_ATTACHMENTS = 10;
/** Maximum size of a single attachment, in bytes (25 MB). */
export const MAX_ATTACHMENT_SIZE = 25 * 1024 * 1024;
/** Maximum combined size of all attachments on a single email, in bytes (40 MB). */
export const MAX_TOTAL_ATTACHMENTS_SIZE = 40 * 1024 * 1024;

/**
 * Validate and sanitize an IMAP mailbox name.
 * Rejects names containing IMAP wildcard characters (`*`, `%`) or empty strings.
 * @param name - The mailbox name to validate.
 * @returns The trimmed mailbox name.
 */
export function sanitizeMailboxName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    throw new Error('Mailbox name must not be empty');
  }
  if (trimmed.includes('*') || trimmed.includes('%')) {
    throw new Error('Mailbox name must not contain IMAP wildcard characters (* or %)');
  }
  return trimmed;
}

/**
 * Strip control characters from an IMAP search query.
 * Removes ASCII 0-31 except tab (0x09) and newline (0x0A).
 * @param query - The raw search query.
 * @returns The sanitized query string.
 */
export function sanitizeSearchQuery(query: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional — sanitize control chars from user input
  const cleaned = query.replace(/[\x00-\x08\x0B-\x1F]/g, '').trim(); // eslint-disable-line no-control-regex
  if (cleaned.length === 0) {
    throw new Error('Search query must not be empty after sanitization');
  }
  return cleaned;
}

/**
 * Validate a webhook URL.
 * Ensures the URL uses http(s) and does not point to a private or loopback address.
 * @param url - The webhook URL to validate.
 */
export function validateWebhookUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid webhook URL: ${url}`);
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`Webhook URL must use http or https protocol, got ${parsed.protocol}`);
  }

  const hostname = parsed.hostname.toLowerCase();

  // new URL('https://[::1]') stores hostname as '[::1]'
  const bare = hostname.replace(/^\[|\]$/g, '');
  if (bare === 'localhost' || bare === '::1' || bare === '0.0.0.0') {
    throw new Error(`Webhook URL must not point to a loopback or private address: ${bare}`);
  }

  const ipv4Match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(bare);
  if (ipv4Match) {
    const [, a, b] = ipv4Match.map(Number);
    if (a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) {
      throw new Error(`Webhook URL must not point to a loopback or private address: ${bare}`);
    }
  }
}

/**
 * Sanitize a value for use in a template.
 * When `html` is true, HTML-special characters are escaped.
 * @param value - The template variable value.
 * @param html - Whether to apply HTML escaping.
 * @returns The sanitized value.
 */
export function sanitizeTemplateVariable(value: string, html: boolean): string {
  if (!html) {
    return value;
  }
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Validate an email label name.
 * Rejects labels with control characters or that exceed 200 characters.
 * @param name - The label name to validate.
 * @returns The trimmed label name.
 */
export function validateLabelName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    throw new Error('Label name must not be empty');
  }
  if (trimmed.length > 200) {
    throw new Error('Label name must not exceed 200 characters');
  }
  /* eslint-disable no-control-regex */
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional — reject control chars in label names
  if (/[\x00-\x1F]/.test(trimmed)) {
    throw new Error('Label name must not contain control characters');
  }
  /* eslint-enable no-control-regex */
  return trimmed;
}

/**
 * Validate that an input string does not exceed a maximum length.
 * @param input - The input string to check.
 * @param maxLength - The maximum allowed length.
 * @param fieldName - The field name for the error message.
 */
export function validateInputLength(input: string, maxLength: number, fieldName: string): void {
  if (input.length > maxLength) {
    throw new Error(`${fieldName} exceeds maximum length of ${maxLength} characters`);
  }
}

/** Decoded byte size of a base64 string, without allocating a Buffer. */
function base64DecodedSize(base64: string): number {
  const cleaned = base64.replace(/\s/g, '');
  let padding = 0;
  if (cleaned.endsWith('==')) padding = 2;
  else if (cleaned.endsWith('=')) padding = 1;
  return Math.floor((cleaned.length * 3) / 4) - padding;
}

/**
 * Validate outgoing email attachments (from send_email, reply_email, forward_email,
 * save_draft). Enforces count and size limits and rejects unsafe filenames.
 * Each attachment must provide exactly one of `content` (base64) or `path`.
 * @param attachments - The attachments to validate.
 */
export function validateAttachments(attachments: AttachmentInput[] | undefined): void {
  if (!attachments || attachments.length === 0) return;

  if (attachments.length > MAX_ATTACHMENTS) {
    throw new Error(
      `Too many attachments: max ${MAX_ATTACHMENTS} allowed, got ${attachments.length}`,
    );
  }

  let totalSize = 0;

  attachments.forEach((att) => {
    const filename = att.filename?.trim();
    if (!filename) {
      throw new Error('Each attachment must have a non-empty filename');
    }
    /* eslint-disable no-control-regex */
    // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional — reject control chars and path separators in filenames
    if (/[\x00-\x1F/\\]/.test(filename)) {
      throw new Error(
        `Attachment filename "${filename}" must not contain path separators or control characters`,
      );
    }
    /* eslint-enable no-control-regex */

    const hasContent = typeof att.content === 'string' && att.content.length > 0;
    const hasPath = typeof att.path === 'string' && att.path.length > 0;
    if (hasContent === hasPath) {
      throw new Error(
        `Attachment "${filename}" must provide exactly one of "content" (base64) or "path"`,
      );
    }

    if (hasContent) {
      const size = base64DecodedSize(att.content as string);
      if (size > MAX_ATTACHMENT_SIZE) {
        throw new Error(
          `Attachment "${filename}" (${Math.round(size / 1024 / 1024)}MB) exceeds the ${MAX_ATTACHMENT_SIZE / 1024 / 1024}MB per-file limit`,
        );
      }
      totalSize += size;
    }
  });

  if (totalSize > MAX_TOTAL_ATTACHMENTS_SIZE) {
    throw new Error(
      `Total attachment size (${Math.round(totalSize / 1024 / 1024)}MB) exceeds the ${MAX_TOTAL_ATTACHMENTS_SIZE / 1024 / 1024}MB combined limit`,
    );
  }
}
