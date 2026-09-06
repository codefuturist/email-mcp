import parseHeaderBlock from './headers.js';

describe('parseHeaderBlock', () => {
  it('parses simple headers with lowercased keys', () => {
    const result = parseHeaderBlock('Subject: Hello\r\nList-Id: <news.example.com>');

    expect(result.subject).toBe('Hello');
    expect(result['list-id']).toBe('<news.example.com>');
  });

  it('unfolds continuation lines per RFC 5322', () => {
    const raw =
      'List-Unsubscribe: <https://example.com/u/abc>,\r\n <mailto:unsub@example.com>\r\nFrom: a@b.c';

    const result = parseHeaderBlock(raw);

    expect(result['list-unsubscribe']).toBe(
      '<https://example.com/u/abc>, <mailto:unsub@example.com>',
    );
    expect(result.from).toBe('a@b.c');
  });

  // Authentication-Results is long and folds routinely. Without unfolding, a
  // parser keeps only "mx.example;" and loses every SPF, DKIM and DMARC result.
  it('keeps every result of a folded Authentication-Results', () => {
    const raw =
      'Authentication-Results: mx.example;\r\n spf=pass smtp.mailfrom=mailer.example;\r\n dkim=pass header.d=mailer.example;\r\n dmarc=pass header.from=mailer.example';

    const value = parseHeaderBlock(raw)['authentication-results'] ?? '';

    expect(value).toContain('spf=pass');
    expect(value).toContain('dkim=pass');
    expect(value).toContain('dmarc=pass');
  });

  // One per relay hop. Overwriting would report only the last verifier.
  it('joins a field that appears more than once', () => {
    const raw = 'Authentication-Results: mx1; spf=pass\r\nAuthentication-Results: mx2; dkim=fail';

    const value = parseHeaderBlock(raw)['authentication-results'];

    expect(value).toBe('mx1; spf=pass\nmx2; dkim=fail');
  });

  it('accepts bare LF as well as CRLF', () => {
    expect(parseHeaderBlock('Precedence: bulk\nList-Id: <x.y>').precedence).toBe('bulk');
  });

  it('stops at the blank line ending the header block', () => {
    const result = parseHeaderBlock('Subject: Hi\r\n\r\nPrecedence: bulk');

    expect(result.subject).toBe('Hi');
    expect(result.precedence).toBeUndefined();
  });

  it('ignores a field with no value', () => {
    expect(parseHeaderBlock('X-Empty:\r\nSubject: Hi')['x-empty']).toBeUndefined();
  });
});
