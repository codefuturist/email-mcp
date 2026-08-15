/**
 * Path-safe attachment download directory helpers.
 *
 * Downloads are confined to a server-configured directory. Agents may only
 * supply a basename — never an absolute or relative path.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

/** Default extensions when the download dir is enabled and no allowlist is set. */
export const DEFAULT_ATTACHMENT_DOWNLOAD_ALLOWED_EXTENSIONS = [
  'pdf',
  'png',
  'jpg',
  'jpeg',
  'webp',
  'tiff',
  'txt',
  'md',
  'doc',
  'docx',
  'odt',
  'xls',
  'xlsx',
  'csv',
] as const;

export const DEFAULT_ATTACHMENT_DOWNLOAD_MAX_BYTES = 25 * 1024 * 1024;

/**
 * Validate that `name` is a single path segment (basename only).
 * Rejects empty names, absolute paths, separators, `.` / `..`, and NULs.
 */
export function assertSafeDownloadBasename(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    throw new Error('Download filename must not be empty');
  }
  if (trimmed.includes('\0')) {
    throw new Error('Download filename must not contain NUL characters');
  }
  if (path.isAbsolute(trimmed)) {
    throw new Error('Download filename must be a basename, not an absolute path');
  }
  if (trimmed.includes('/') || trimmed.includes('\\')) {
    throw new Error('Download filename must not contain path separators');
  }
  if (trimmed === '.' || trimmed === '..') {
    throw new Error('Download filename must not be "." or ".."');
  }
  const base = path.basename(trimmed);
  if (base !== trimmed) {
    throw new Error('Download filename must be a basename');
  }
  return base;
}

/**
 * Derive a safe basename from an attachment filename (strips paths / unsafe chars).
 */
export function sanitizeAttachmentBasename(filename: string): string {
  const normalized = filename.replace(/\\/g, '/');
  const base = path.basename(normalized);
  const cleaned = base.replace(/[^\w.\- ()[\]]+/g, '_').replace(/^\.+/, '');
  return assertSafeDownloadBasename(cleaned.length > 0 ? cleaned : 'attachment');
}

/**
 * Ensure the file extension is on the allowlist (case-insensitive, leading dots ignored).
 */
export function assertAllowedExtension(filename: string, allowlist: readonly string[]): void {
  const ext = path.extname(filename).slice(1).toLowerCase();
  const normalized = allowlist.map((e) => e.toLowerCase().replace(/^\./, ''));
  if (!ext || !normalized.includes(ext)) {
    throw new Error(
      `Extension ${ext ? `".${ext}"` : '(none)'} is not allowed for attachment downloads. ` +
        `Allowed: ${normalized.join(', ')}`,
    );
  }
}

/**
 * Resolve a basename under `downloadDir`, creating the directory if needed.
 * Guarantees the final path cannot escape the download dir via `..` or separators.
 */
export async function resolveAttachmentDownloadPath(
  downloadDir: string,
  basename: string,
): Promise<string> {
  const safe = assertSafeDownloadBasename(basename);
  await fs.mkdir(downloadDir, { recursive: true });
  const rootResolved = await fs.realpath(downloadDir);
  const target = path.resolve(rootResolved, safe);
  const prefix = rootResolved.endsWith(path.sep) ? rootResolved : `${rootResolved}${path.sep}`;
  if (!target.startsWith(prefix)) {
    throw new Error('Resolved path escapes attachment download directory');
  }
  return target;
}

/**
 * Write `content` to `targetPath` atomically via a temp file + rename.
 * Rename replaces an existing file or symlink rather than writing through it.
 */
export async function writeDownloadFileAtomic(targetPath: string, content: Buffer): Promise<void> {
  const dir = path.dirname(targetPath);
  const tmp = path.join(dir, `.${path.basename(targetPath)}.${process.pid}.${Date.now()}.tmp`);
  try {
    await fs.writeFile(tmp, content, { flag: 'wx' });
    await fs.rename(tmp, targetPath);
  } catch (err) {
    try {
      await fs.unlink(tmp);
    } catch {
      // ignore cleanup errors
    }
    throw err;
  }
}

/**
 * Parse a comma-separated extension allowlist from env / config.
 */
export function parseExtensionAllowlist(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim().length === 0) {
    return [...DEFAULT_ATTACHMENT_DOWNLOAD_ALLOWED_EXTENSIONS];
  }
  return raw
    .split(',')
    .map((e) => e.trim().toLowerCase().replace(/^\./, ''))
    .filter(Boolean);
}
