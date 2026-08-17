/** Input validation and sanitization utilities. */

import { realpath, stat } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

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

/**
 * Validate an attachment file path.
 *
 * Rejects paths containing null bytes or control characters, resolves the path
 * to an absolute one, and ensures the target exists, is a regular file, and
 * does not exceed the size limit. Symlinks are resolved before validation so a
 * link cannot be used to reach an unintended target.
 *
 * @param filePath - The attachment path to validate.
 * @param maxBytes - Maximum allowed file size in bytes.
 * @returns The resolved absolute path and its size in bytes.
 */
export async function validateAttachmentPath(
  filePath: string,
  maxBytes: number,
): Promise<{ path: string; size: number }> {
  if (filePath.includes('\0')) {
    throw new Error('Attachment path must not contain null bytes');
  }

  const trimmed = filePath.trim();
  if (trimmed.length === 0) {
    throw new Error('Attachment path must not be empty');
  }

  const resolved = await realpath(resolve(trimmed));

  const stats = await stat(resolved);
  if (!stats.isFile()) {
    throw new Error(`Attachment is not a regular file: ${filePath}`);
  }
  if (stats.size > maxBytes) {
    throw new Error(
      `Attachment ${basename(resolved)} is ${stats.size} bytes, exceeding the ${maxBytes} byte limit`,
    );
  }

  return { path: resolved, size: stats.size };
}
