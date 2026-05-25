import type { Email } from '../types/index.js';
import { quoteOriginalAsHtml, quoteOriginalAsText } from './quote.js';

function makeEmail(overrides: Partial<Email> = {}): Email {
  return {
    id: '1',
    subject: 'Greetings',
    from: { name: 'Alex Chery', address: 'alex@example.com' },
    to: [{ address: 'me@example.com' }],
    date: 'Mon, 25 May 2026 16:11:00 +0200',
    seen: true,
    flagged: false,
    answered: false,
    hasAttachments: false,
    labels: [],
    messageId: '<abc@example.com>',
    bodyText: 'Hello there.\nHow are you?',
    attachments: [],
    headers: {},
    ...overrides,
  };
}

describe('quoteOriginalAsText', () => {
  it('builds attribution and > prefix for each line', () => {
    const out = quoteOriginalAsText(makeEmail());
    expect(out).toBe(
      '\n\nOn Mon, 25 May 2026 16:11:00 +0200, Alex Chery <alex@example.com> wrote:\n> Hello there.\n> How are you?',
    );
  });

  it('falls back to stripped HTML when no bodyText', () => {
    const out = quoteOriginalAsText(
      makeEmail({ bodyText: undefined, bodyHtml: '<p>Hello</p><p>World</p>' }),
    );
    expect(out).toContain('> Hello');
    expect(out).toContain('> World');
  });

  it('uses bare address when no display name', () => {
    const out = quoteOriginalAsText(makeEmail({ from: { address: 'noreply@bot.com' } }));
    expect(out).toContain('noreply@bot.com wrote:');
  });

  it('preserves blank lines with bare > prefix', () => {
    const out = quoteOriginalAsText(makeEmail({ bodyText: 'A\n\nB' }));
    expect(out).toContain('> A\n>\n> B');
  });
});

describe('quoteOriginalAsHtml', () => {
  it('wraps original HTML body in <blockquote type="cite">', () => {
    const out = quoteOriginalAsHtml(makeEmail({ bodyHtml: '<p>Hi</p>' }));
    expect(out).toContain('<blockquote type="cite"');
    expect(out).toContain('<p>Hi</p>');
    expect(out).toContain('Alex Chery &lt;alex@example.com&gt; wrote:');
  });

  it('wraps plain-text body in escaped <pre> when no HTML available', () => {
    const out = quoteOriginalAsHtml(makeEmail({ bodyText: 'A < B', bodyHtml: undefined }));
    expect(out).toContain('A &lt; B');
    expect(out).toContain('<pre');
  });

  it('escapes attribution sender name', () => {
    const out = quoteOriginalAsHtml(makeEmail({ from: { name: '<weird>', address: 'a@b.com' } }));
    expect(out).toContain('&lt;weird&gt; &lt;a@b.com&gt; wrote:');
  });
});
