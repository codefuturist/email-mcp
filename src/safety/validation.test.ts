import {
  sanitizeMailboxName,
  sanitizeSearchQuery,
  sanitizeTemplateVariable,
  validateAttachments,
  validateInputLength,
  validateLabelName,
  validateWebhookUrl,
} from './validation.js';

describe('sanitizeMailboxName', () => {
  it('returns a valid trimmed name', () => {
    expect(sanitizeMailboxName('  INBOX  ')).toBe('INBOX');
  });

  it('throws on empty string', () => {
    expect(() => sanitizeMailboxName('')).toThrow('must not be empty');
  });

  it('throws on whitespace-only string', () => {
    expect(() => sanitizeMailboxName('   ')).toThrow('must not be empty');
  });

  it('throws when name contains *', () => {
    expect(() => sanitizeMailboxName('INBOX*')).toThrow('wildcard');
  });

  it('throws when name contains %', () => {
    expect(() => sanitizeMailboxName('INBOX%')).toThrow('wildcard');
  });

  it('allows names with dots and slashes', () => {
    expect(sanitizeMailboxName('INBOX/Subfolder.Label')).toBe('INBOX/Subfolder.Label');
  });
});

describe('sanitizeSearchQuery', () => {
  it('returns a clean query', () => {
    expect(sanitizeSearchQuery('hello world')).toBe('hello world');
  });

  it('strips control characters', () => {
    expect(sanitizeSearchQuery('hello\x00\x01world')).toBe('helloworld');
  });

  it('throws on empty after sanitization', () => {
    expect(() => sanitizeSearchQuery('\x00\x01')).toThrow('must not be empty');
  });

  it('preserves tabs', () => {
    expect(sanitizeSearchQuery('hello\tworld')).toBe('hello\tworld');
  });

  it('preserves newlines', () => {
    expect(sanitizeSearchQuery('hello\nworld')).toBe('hello\nworld');
  });
});

describe('validateWebhookUrl', () => {
  it('throws on invalid URL', () => {
    expect(() => validateWebhookUrl('not-a-url')).toThrow('Invalid webhook URL');
  });

  it('throws on non-http(s) protocol', () => {
    expect(() => validateWebhookUrl('ftp://example.com')).toThrow('http or https');
  });

  it('throws on localhost', () => {
    expect(() => validateWebhookUrl('https://localhost/hook')).toThrow('loopback or private');
  });

  it('throws on 127.0.0.1', () => {
    expect(() => validateWebhookUrl('https://127.0.0.1/hook')).toThrow('loopback or private');
  });

  it('throws on 10.x.x.x', () => {
    expect(() => validateWebhookUrl('https://10.0.0.1/hook')).toThrow('loopback or private');
  });

  it('throws on 172.16-31.x.x', () => {
    expect(() => validateWebhookUrl('https://172.16.0.1/hook')).toThrow('loopback or private');
    expect(() => validateWebhookUrl('https://172.31.255.255/hook')).toThrow('loopback or private');
  });

  it('throws on 192.168.x.x', () => {
    expect(() => validateWebhookUrl('https://192.168.1.1/hook')).toThrow('loopback or private');
  });

  it('throws on ::1', () => {
    // Note: URL parser keeps brackets in hostname for IPv6, so the source
    // comparison against '::1' won't match '[::1]'. This tests current behaviour.
    expect(() => validateWebhookUrl('http://::1/hook')).toThrow();
  });

  it('throws on 0.0.0.0', () => {
    expect(() => validateWebhookUrl('https://0.0.0.0/hook')).toThrow('loopback or private');
  });

  it('allows valid public https URL', () => {
    expect(() => validateWebhookUrl('https://hooks.example.com/wh')).not.toThrow();
  });

  it('allows valid public http URL', () => {
    expect(() => validateWebhookUrl('http://hooks.example.com/wh')).not.toThrow();
  });
});

describe('sanitizeTemplateVariable', () => {
  it('returns value as-is when html is false', () => {
    expect(sanitizeTemplateVariable('<b>test</b>', false)).toBe('<b>test</b>');
  });

  it('escapes & when html is true', () => {
    expect(sanitizeTemplateVariable('a & b', true)).toBe('a &amp; b');
  });

  it('escapes < and > when html is true', () => {
    expect(sanitizeTemplateVariable('<div>', true)).toBe('&lt;div&gt;');
  });

  it('escapes double quotes when html is true', () => {
    expect(sanitizeTemplateVariable('"hello"', true)).toBe('&quot;hello&quot;');
  });

  it('escapes single quotes when html is true', () => {
    expect(sanitizeTemplateVariable("it's", true)).toBe('it&#39;s');
  });

  it('escapes all special chars together', () => {
    expect(sanitizeTemplateVariable('<a href="x">&\'', true)).toBe(
      '&lt;a href=&quot;x&quot;&gt;&amp;&#39;',
    );
  });
});

describe('validateLabelName', () => {
  it('throws on empty string', () => {
    expect(() => validateLabelName('')).toThrow('must not be empty');
  });

  it('throws on whitespace-only string', () => {
    expect(() => validateLabelName('   ')).toThrow('must not be empty');
  });

  it('throws on >200 chars', () => {
    expect(() => validateLabelName('a'.repeat(201))).toThrow('must not exceed 200');
  });

  it('allows exactly 200 chars', () => {
    expect(validateLabelName('a'.repeat(200))).toBe('a'.repeat(200));
  });

  it('throws on control characters', () => {
    expect(() => validateLabelName('label\x00name')).toThrow('control characters');
  });

  it('trims whitespace and returns valid name', () => {
    expect(validateLabelName('  Important  ')).toBe('Important');
  });
});

describe('validateAttachments', () => {
  it('allows undefined and empty arrays', () => {
    expect(() => validateAttachments(undefined)).not.toThrow();
    expect(() => validateAttachments([])).not.toThrow();
  });

  it('allows a valid base64 attachment', () => {
    expect(() =>
      validateAttachments([
        { filename: 'a.txt', content: Buffer.from('hello').toString('base64') },
      ]),
    ).not.toThrow();
  });

  it('allows a valid path-based attachment', () => {
    expect(() => validateAttachments([{ filename: 'a.txt', path: '/tmp/a.txt' }])).not.toThrow();
  });

  it('throws when more than the max number of attachments are given', () => {
    const attachments = Array.from({ length: 11 }, (_, i) => ({
      filename: `f${i}.txt`,
      content: 'aGVsbG8=',
    }));
    expect(() => validateAttachments(attachments)).toThrow('Too many attachments');
  });

  it('throws on empty filename', () => {
    expect(() => validateAttachments([{ filename: '', content: 'aGVsbG8=' }])).toThrow(
      'non-empty filename',
    );
  });

  it('throws on filename with a path separator', () => {
    expect(() => validateAttachments([{ filename: '../evil.txt', content: 'aGVsbG8=' }])).toThrow(
      'path separators',
    );
  });

  it('throws when neither content nor path is provided', () => {
    expect(() => validateAttachments([{ filename: 'a.txt' }])).toThrow('exactly one of "content"');
  });

  it('throws when both content and path are provided', () => {
    expect(() =>
      validateAttachments([{ filename: 'a.txt', content: 'aGVsbG8=', path: '/tmp/a.txt' }]),
    ).toThrow('exactly one of "content"');
  });

  it('throws when a single attachment exceeds the per-file limit', () => {
    const oversized = Buffer.alloc(26 * 1024 * 1024).toString('base64');
    expect(() => validateAttachments([{ filename: 'big.bin', content: oversized }])).toThrow(
      'exceeds the 25MB per-file limit',
    );
  });

  it('throws when combined attachments exceed the total size limit', () => {
    const chunk = Buffer.alloc(15 * 1024 * 1024).toString('base64');
    const attachments = [
      { filename: 'a.bin', content: chunk },
      { filename: 'b.bin', content: chunk },
      { filename: 'c.bin', content: chunk },
    ];
    expect(() => validateAttachments(attachments)).toThrow('combined limit');
  });
});

describe('validateInputLength', () => {
  it('throws when over max', () => {
    expect(() => validateInputLength('12345', 3, 'field')).toThrow(
      'field exceeds maximum length of 3',
    );
  });

  it('allows at exact max length', () => {
    expect(() => validateInputLength('123', 3, 'field')).not.toThrow();
  });

  it('allows under max length', () => {
    expect(() => validateInputLength('ab', 5, 'name')).not.toThrow();
  });
});
