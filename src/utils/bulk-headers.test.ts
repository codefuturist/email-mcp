import { classifyBulk, parseHeaderBlock } from './bulk-headers.js';

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

  it('accepts bare LF as well as CRLF', () => {
    expect(parseHeaderBlock('Precedence: bulk\nList-Id: <x.y>').precedence).toBe('bulk');
  });

  it('stops at the blank line ending the header block', () => {
    const result = parseHeaderBlock('Subject: Hi\r\n\r\nPrecedence: bulk');

    expect(result.subject).toBe('Hi');
    expect(result.precedence).toBeUndefined();
  });
});

describe('classifyBulk', () => {
  it('returns undefined for ordinary personal mail', () => {
    expect(classifyBulk({ subject: 'Lunch?', from: 'friend@example.com' })).toBeUndefined();
  });

  it('classifies List-Unsubscribe as a newsletter', () => {
    const signal = classifyBulk({ 'list-unsubscribe': '<https://example.com/u/abc>' });

    expect(signal?.kind).toBe('newsletter');
    expect(signal?.unsubscribe).toBe('https://example.com/u/abc');
    expect(signal?.oneClick).toBe(false);
  });

  it('prefers an https unsubscribe URI over mailto', () => {
    const signal = classifyBulk({
      'list-unsubscribe': '<mailto:unsub@example.com>, <https://example.com/u/abc>',
    });

    expect(signal?.unsubscribe).toBe('https://example.com/u/abc');
  });

  it('falls back to mailto when no http URI is offered', () => {
    const signal = classifyBulk({ 'list-unsubscribe': '<mailto:unsub@example.com>' });

    expect(signal?.unsubscribe).toBe('mailto:unsub@example.com');
  });

  it('flags one-click unsubscribe from List-Unsubscribe-Post', () => {
    const signal = classifyBulk({
      'list-unsubscribe': '<https://example.com/u/abc>',
      'list-unsubscribe-post': 'List-Unsubscribe=One-Click',
    });

    expect(signal?.oneClick).toBe(true);
  });

  it('strips angle brackets from List-Id', () => {
    expect(classifyBulk({ 'list-id': 'News <news.example.com>' })?.listId).toBe('news.example.com');
  });

  it('classifies Auto-Submitted as automated', () => {
    const signal = classifyBulk({ 'auto-submitted': 'auto-generated' });

    expect(signal?.kind).toBe('automated');
    expect(signal?.unsubscribe).toBeUndefined();
  });

  it('treats Auto-Submitted: no as personal mail', () => {
    expect(classifyBulk({ 'auto-submitted': 'no' })).toBeUndefined();
  });

  it('classifies Precedence: bulk as automated', () => {
    expect(classifyBulk({ precedence: 'bulk' })?.kind).toBe('automated');
  });

  it('classifies Precedence: list as a newsletter', () => {
    expect(classifyBulk({ precedence: 'list' })?.kind).toBe('newsletter');
  });

  it('prefers newsletter when a sender sets both list and automated markers', () => {
    const signal = classifyBulk({
      'list-unsubscribe': '<https://example.com/u/abc>',
      'auto-submitted': 'auto-generated',
      precedence: 'bulk',
    });

    expect(signal?.kind).toBe('newsletter');
  });
});
