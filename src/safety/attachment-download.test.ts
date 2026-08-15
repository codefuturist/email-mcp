import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  assertAllowedExtension,
  assertSafeDownloadBasename,
  parseExtensionAllowlist,
  resolveAttachmentDownloadPath,
  sanitizeAttachmentBasename,
  writeDownloadFileAtomic,
} from './attachment-download.js';

describe('assertSafeDownloadBasename', () => {
  it('accepts a simple basename', () => {
    expect(assertSafeDownloadBasename('invoice.pdf')).toBe('invoice.pdf');
  });

  it('trims whitespace', () => {
    expect(assertSafeDownloadBasename('  report.docx  ')).toBe('report.docx');
  });

  it('rejects empty', () => {
    expect(() => assertSafeDownloadBasename('')).toThrow('must not be empty');
  });

  it('rejects absolute paths', () => {
    expect(() => assertSafeDownloadBasename('/tmp/evil.pdf')).toThrow('absolute');
  });

  it('rejects path separators', () => {
    expect(() => assertSafeDownloadBasename('subdir/file.pdf')).toThrow('path separators');
    expect(() => assertSafeDownloadBasename('subdir\\file.pdf')).toThrow('path separators');
  });

  it('rejects .. and .', () => {
    expect(() => assertSafeDownloadBasename('..')).toThrow();
    expect(() => assertSafeDownloadBasename('.')).toThrow();
  });

  it('rejects NUL', () => {
    expect(() => assertSafeDownloadBasename('a\0b.pdf')).toThrow('NUL');
  });
});

describe('sanitizeAttachmentBasename', () => {
  it('strips directory components', () => {
    expect(sanitizeAttachmentBasename('../../etc/passwd.pdf')).toBe('passwd.pdf');
  });

  it('replaces unsafe characters', () => {
    expect(sanitizeAttachmentBasename('my:file*.pdf')).toBe('my_file_.pdf');
  });
});

describe('assertAllowedExtension', () => {
  const allow = ['pdf', 'png'];

  it('allows listed extensions case-insensitively', () => {
    expect(() => assertAllowedExtension('a.PDF', allow)).not.toThrow();
    expect(() => assertAllowedExtension('a.png', allow)).not.toThrow();
  });

  it('rejects unlisted extensions', () => {
    expect(() => assertAllowedExtension('a.exe', allow)).toThrow('not allowed');
  });

  it('rejects missing extension', () => {
    expect(() => assertAllowedExtension('noext', allow)).toThrow('not allowed');
  });
});

describe('parseExtensionAllowlist', () => {
  it('returns defaults for empty input', () => {
    expect(parseExtensionAllowlist(undefined)).toContain('pdf');
    expect(parseExtensionAllowlist('')).toContain('pdf');
  });

  it('parses comma-separated list', () => {
    expect(parseExtensionAllowlist('.PDF, png ,DOCX')).toEqual(['pdf', 'png', 'docx']);
  });
});

describe('resolveAttachmentDownloadPath + writeDownloadFileAtomic', () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'email-mcp-attach-dl-'));
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it('resolves under the download dir root', async () => {
    const target = await resolveAttachmentDownloadPath(tmpRoot, 'doc.pdf');
    expect(target).toBe(path.join(await fs.realpath(tmpRoot), 'doc.pdf'));
  });

  it('writes atomically and replaces a symlink destination', async () => {
    const outside = path.join(tmpRoot, 'outside.txt');
    await fs.writeFile(outside, 'secret');

    const linkPath = path.join(tmpRoot, 'link.pdf');
    await fs.symlink(outside, linkPath);

    const target = await resolveAttachmentDownloadPath(tmpRoot, 'link.pdf');
    await writeDownloadFileAtomic(target, Buffer.from('safe-content'));

    const linkStat = await fs.lstat(target);
    expect(linkStat.isSymbolicLink()).toBe(false);
    expect(await fs.readFile(target, 'utf8')).toBe('safe-content');
    expect(await fs.readFile(outside, 'utf8')).toBe('secret');
  });

  it('rejects escape attempts via basename validation before resolve', async () => {
    await expect(resolveAttachmentDownloadPath(tmpRoot, '../escape.pdf')).rejects.toThrow(
      'path separators',
    );
  });
});
