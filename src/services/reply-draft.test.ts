import type { Account, Email } from '../types/index.js';
import {
  attributionLine,
  buildReplyDraft,
  composeReplyBodies,
  plainTextToHtml,
  quoteOriginalHtml,
  quoteOriginalText,
  replyRecipients,
  replyReferences,
  replySubject,
  unwrapHtmlDocument,
} from './reply-draft.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const account: Account = { name: 'test', email: 'me@example.com', fullName: 'Zoë Tester' };

const original: Email = {
  id: '123',
  subject: 'Data processing agreement',
  from: { name: 'Tom Sender', address: 'tom@example.org' },
  to: [{ name: 'Zoë Tester', address: 'me@example.com' }, { address: 'office@example.com' }],
  cc: [{ address: 'accounting@example.org' }, { address: 'me@example.com' }],
  date: '2026-09-16T08:15:00.000Z',
  seen: true,
  flagged: false,
  answered: false,
  hasAttachments: false,
  labels: [],
  messageId: '<orig-123@example.org>',
  references: ['<root@example.org>'],
  bodyText: 'Hello,\r\nplease sign the agreement.\r\n\r\nRegards\r\nTom\r\n',
  attachments: [],
  headers: {},
};

function header(raw: string, name: string): string | undefined {
  const head = raw.split('\r\n\r\n')[0];
  const match = new RegExp(`^${name}: (.*(?:\\r\\n[ \\t].*)*)`, 'mi').exec(head);
  return match ? match[1].replace(/\r\n[ \t]+/g, ' ') : undefined;
}

function decodeQuotedPrintable(body: string): string {
  const bytes = body
    .replace(/=\r\n/g, '')
    .replace(/=([0-9A-F]{2})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  return Buffer.from(bytes, 'latin1').toString('utf8');
}

function decodedBodies(raw: string): string {
  // Prefer the HTML part when multipart/alternative; fall back to whole payload.
  const htmlBoundary =
    /Content-Type: text\/html; charset=utf-8\r\n(?:.*\r\n)*?\r\n([\s\S]*?)(?:\r\n--|\r\n$)/i.exec(
      raw,
    );
  if (htmlBoundary) return decodeQuotedPrintable(htmlBoundary[1]);
  return decodeQuotedPrintable(raw.split('\r\n\r\n').slice(1).join('\r\n\r\n'));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('replySubject', () => {
  it('prefixes Re: once, case-insensitively', () => {
    expect(replySubject('Data processing agreement')).toBe('Re: Data processing agreement');
    expect(replySubject('Re: Agreement')).toBe('Re: Agreement');
    expect(replySubject('RE: Agreement')).toBe('RE: Agreement');
    expect(replySubject(undefined)).toBe('Re: ');
  });
});

describe('replyRecipients', () => {
  it('replies to the sender only by default', () => {
    const { to, cc } = replyRecipients(original, account.email, false);
    expect(to.map((a) => a.address)).toEqual(['tom@example.org']);
    expect(cc).toEqual([]);
  });

  it('adds original To/Cc without our own address on replyAll', () => {
    const { to, cc } = replyRecipients(original, account.email, true);
    expect(to.map((a) => a.address)).toEqual(['tom@example.org', 'office@example.com']);
    expect(cc.map((a) => a.address)).toEqual(['accounting@example.org']);
  });

  it('honours Reply-To over From', () => {
    const { to } = replyRecipients(
      { ...original, replyTo: [{ address: 'desk@example.org' }] },
      account.email,
      false,
    );
    expect(to.map((a) => a.address)).toEqual(['desk@example.org']);
  });

  it('replies to the original recipients when the sender is ourselves', () => {
    const { to } = replyRecipients(
      { ...original, from: { address: account.email }, to: [{ address: 'tom@example.org' }] },
      account.email,
      false,
    );
    expect(to.map((a) => a.address)).toEqual(['tom@example.org']);
  });
});

describe('replyReferences', () => {
  it('appends the original Message-ID to its References chain', () => {
    expect(replyReferences(original)).toEqual(['<root@example.org>', '<orig-123@example.org>']);
    expect(replyReferences({ ...original, references: undefined })).toEqual([
      '<orig-123@example.org>',
    ]);
  });
});

describe('attributionLine', () => {
  it('uses Mailbird Polish wording with local date and address', () => {
    expect(attributionLine(original)).toMatch(
      /^W dniu 16\.09\.2026 \d{2}:\d{2}:\d{2}, Tom Sender <tom@example\.org> pisze:$/,
    );
  });
});

describe('plainTextToHtml / unwrapHtmlDocument', () => {
  it('turns plain lines into div blocks without a pre wrapper', () => {
    expect(plainTextToHtml('Hello,\n\nTom')).toBe('<div>Hello,</div><div><br></div><div>Tom</div>');
  });

  it('unwraps html/body documents to an embeddable fragment', () => {
    expect(unwrapHtmlDocument('<html><body><p>Hi</p></body></html>')).toBe('<p>Hi</p>');
  });
});

describe('quoteOriginalHtml', () => {
  it('emits a Mailbird history_container and preserves original HTML', () => {
    const html = quoteOriginalHtml({
      ...original,
      bodyHtml: '<html><body><p>Hello <b>there</b></p></body></html>',
    });
    expect(html).toContain('class="history_container"');
    expect(html).toContain('type="cite"');
    expect(html).toContain('<p>Hello <b>there</b></p>');
    expect(html).not.toContain('<pre>');
    expect(html).toMatch(/W dniu .* pisze:/);
    expect(html).toContain('color: #AAAAAA');
  });

  it('converts plain-text originals to HTML divs instead of pre', () => {
    const html = quoteOriginalHtml(original);
    expect(html).toContain('class="history_container"');
    expect(html).toContain('<div>Hello,</div>');
    expect(html).toContain('<div>please sign the agreement.</div>');
    expect(html).not.toContain('<pre>');
  });
});

describe('quoteOriginalText', () => {
  it('prefixes every original line with "> " below an attribution line', () => {
    const quoted = quoteOriginalText(original);
    expect(quoted.startsWith(attributionLine(original))).toBe(true);
    expect(quoted).toContain('> Hello,');
    expect(quoted).toContain('> please sign the agreement.');
    expect(quoted).toContain('> Regards');
    expect(quoted).toContain('> Tom');
  });
});

describe('composeReplyBodies', () => {
  it('always emits HTML with history when quoting, even for plain reply bodies', () => {
    const bodies = composeReplyBodies(original, { body: 'OK' });
    expect(bodies.html).toContain('<div>OK</div>');
    expect(bodies.html).toContain('history_container');
    expect(bodies.text).toContain('OK\n\nW dniu');
  });
});

describe('buildReplyDraft', () => {
  it('builds a threaded HTML reply with Mailbird history when quoting', async () => {
    const draft = await buildReplyDraft(account, original, {
      body: 'Hello,\nsigned copy attached.\n\nRegards\nZoë',
    });
    const raw = draft.raw.toString('utf8');

    expect(header(raw, 'In-Reply-To')).toBe('<orig-123@example.org>');
    expect(header(raw, 'References')).toBe('<root@example.org> <orig-123@example.org>');
    expect(header(raw, 'Subject')).toBe('Re: Data processing agreement');
    expect(header(raw, 'To')).toContain('tom@example.org');
    expect(header(raw, 'From')).toContain('me@example.com');
    expect(draft.html).toBe(true);
    expect(raw).toMatch(/Content-Type: text\/html; charset=utf-8/i);

    const body = decodedBodies(raw);
    expect(body).toContain('class="history_container"');
    expect(body).toContain('<div>Hello,</div>');
    expect(body).toContain('<div>signed copy attached.</div>');
    expect(body).toContain('<div>please sign the agreement.</div>');
    expect(body).not.toContain('<pre>');

    expect(draft.subject).toBe('Re: Data processing agreement');
    expect(draft.to.map((a) => a.address)).toEqual(['tom@example.org']);
  });

  it('omits the quote when quoteOriginal is false', async () => {
    const draft = await buildReplyDraft(account, original, { body: 'OK', quoteOriginal: false });
    const body = decodeQuotedPrintable(
      draft.raw.toString('utf8').split('\r\n\r\n').slice(1).join(''),
    );
    expect(body.trim()).toBe('OK');
    expect(draft.html).toBe(false);
  });

  it('embeds the original HTML fragment inside history_container', async () => {
    const draft = await buildReplyDraft(
      account,
      { ...original, bodyHtml: '<p>Hello <b>there</b></p>' },
      { body: '<p>OK</p>', html: true },
    );
    const raw = draft.raw.toString('utf8');
    const body = decodedBodies(raw);
    expect(body).toContain('class="history_container"');
    expect(body).toContain('<p>Hello <b>there</b></p>');
    expect(body).toContain('<p>OK</p>');
  });

  it('includes attachments in the composed MIME', async () => {
    const draft = await buildReplyDraft(account, original, {
      body: 'Signed.',
      quoteOriginal: false,
      attachments: [
        {
          filename: 'signed.pdf',
          content: Buffer.from('pdf-bytes'),
          contentType: 'application/pdf',
        },
      ],
    });
    const raw = draft.raw.toString('utf8');
    expect(raw).toContain('multipart/mixed');
    expect(raw).toContain('Content-Disposition: attachment; filename=signed.pdf');
    expect(raw).toContain(Buffer.from('pdf-bytes').toString('base64'));
  });
});
