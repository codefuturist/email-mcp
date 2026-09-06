import {
  buildPreview,
  decodeCharset,
  decodeTransferEncoding,
  findPreviewPart,
  PREVIEW_LENGTH,
  stripHtml,
} from './body-preview.js';

describe('decodeTransferEncoding', () => {
  it('passes 8bit content through untouched', () => {
    expect(decodeTransferEncoding(Buffer.from('plain text'), '8bit').toString()).toBe('plain text');
  });

  it('treats a missing encoding as raw bytes', () => {
    expect(decodeTransferEncoding(Buffer.from('plain'), undefined).toString()).toBe('plain');
  });

  it('decodes quoted-printable escapes', () => {
    const raw = Buffer.from('caf=C3=A9 cr=C3=A8me');

    expect(decodeTransferEncoding(raw, 'quoted-printable').toString('utf-8')).toBe('café crème');
  });

  it('joins quoted-printable soft line breaks', () => {
    const raw = Buffer.from('one =\r\ntwo');

    expect(decodeTransferEncoding(raw, 'quoted-printable').toString()).toBe('one two');
  });

  // The fetch cuts the body at a byte count, not at an encoding boundary.
  it('drops a quoted-printable escape cut in half by truncation', () => {
    const raw = Buffer.from('caf=C3=A9 and then =C');

    const out = decodeTransferEncoding(raw, 'quoted-printable').toString('utf-8');

    expect(out).toBe('café and then ');
    expect(out).not.toContain('=C');
  });

  // A complete "=C3" escape can still be an incomplete UTF-8 character. The
  // decoder's job is the bytes; buildPreview cleans up what charset decoding
  // then turns into a replacement character.
  it('emits the byte of a complete escape even when the character is partial', () => {
    const out = decodeTransferEncoding(Buffer.from('caf=C3'), 'quoted-printable');

    expect(out[out.length - 1]).toBe(0xc3);
  });

  it('drops a lone trailing = from quoted-printable', () => {
    expect(decodeTransferEncoding(Buffer.from('text ='), 'quoted-printable').toString()).toBe(
      'text ',
    );
  });

  it('decodes base64', () => {
    const raw = Buffer.from(Buffer.from('hello world').toString('base64'));

    expect(decodeTransferEncoding(raw, 'base64').toString()).toBe('hello world');
  });

  it('truncates base64 to a whole group rather than emitting garbage', () => {
    const full = Buffer.from('hello world').toString('base64');
    const cut = Buffer.from(full.slice(0, full.length - 3));

    const out = decodeTransferEncoding(cut, 'base64').toString();

    expect('hello world').toContain(out);
  });

  it('ignores line breaks inside a base64 stream', () => {
    const b64 = Buffer.from('hello world').toString('base64');
    const wrapped = Buffer.from(`${b64.slice(0, 4)}\r\n${b64.slice(4)}`);

    expect(decodeTransferEncoding(wrapped, 'base64').toString()).toBe('hello world');
  });
});

describe('decodeCharset', () => {
  it('decodes utf-8 by default', () => {
    expect(decodeCharset(Buffer.from('café', 'utf-8'), undefined)).toBe('café');
  });

  it('decodes iso-8859-1, which real mail still uses', () => {
    expect(decodeCharset(Buffer.from([0x63, 0x61, 0x66, 0xe9]), 'iso-8859-1')).toBe('café');
  });

  it('is case-insensitive about the charset label', () => {
    expect(decodeCharset(Buffer.from('café', 'utf-8'), 'UTF-8')).toBe('café');
  });

  it('falls back to utf-8 for an unknown charset rather than throwing', () => {
    expect(decodeCharset(Buffer.from('hello'), 'x-nonsense-charset')).toBe('hello');
  });

  it('does not throw on a character cut in half by truncation', () => {
    const cut = Buffer.from('café', 'utf-8').subarray(0, 4);

    expect(() => decodeCharset(cut, 'utf-8')).not.toThrow();
  });
});

describe('stripHtml', () => {
  it('removes tags and collapses whitespace', () => {
    expect(stripHtml('<p>Hello   <b>there</b></p>')).toBe('Hello there');
  });

  it('drops style and script content entirely', () => {
    expect(stripHtml('<style>p{color:red}</style><p>Body</p>')).toBe('Body');
    expect(stripHtml('<script>var x=1</script><p>Body</p>')).toBe('Body');
  });

  it('drops the head, which is never content', () => {
    const doc =
      '<!DOCTYPE html><html><head><meta charset="utf-8"><title>x</title></head><body>Real text</body></html>';

    expect(stripHtml(doc)).toBe('Real text');
  });

  // A fetch that stops at a byte count routinely ends inside a tag. Without
  // this, the preview reads "<meta name=" instead of the message.
  it('drops a tag the fetch cut in half', () => {
    expect(stripHtml('Body text <meta name="viewport" content="width=device-')).toBe('Body text');
  });

  it('drops a style block the fetch cut in half', () => {
    expect(stripHtml('<p>Body</p><style>.a{color:red;} .b{margin:0')).toBe('Body');
  });

  it('does not leave a space before punctuation where a tag was', () => {
    expect(stripHtml('<p>Hello <b>there</b>, and <i>you</i>.</p>')).toBe('Hello there, and you.');
  });
});

describe('findPreviewPart', () => {
  it('uses section 1 for a single-part message', () => {
    const part = findPreviewPart({
      type: 'text/html',
      encoding: 'base64',
      parameters: { charset: 'utf-8' },
    });

    expect(part).toEqual({ key: '1', type: 'text/html', encoding: 'base64', charset: 'utf-8' });
  });

  it('prefers the first alternative of a multipart', () => {
    const part = findPreviewPart({
      type: 'multipart/alternative',
      childNodes: [
        {
          part: '1',
          type: 'text/plain',
          encoding: 'quoted-printable',
          parameters: { charset: 'utf-8' },
        },
        { part: '2', type: 'text/html', encoding: 'quoted-printable' },
      ],
    });

    expect(part?.key).toBe('1');
    expect(part?.type).toBe('text/plain');
  });

  // Roughly 4% of real messages. Fetching 1.1 needs a separate pass, because
  // asking for a section a message lacks fails the whole batch on Gmail.
  it('descends to 1.1 when section 1 is itself a multipart', () => {
    const part = findPreviewPart({
      type: 'multipart/mixed',
      childNodes: [
        {
          part: '1',
          type: 'multipart/alternative',
          childNodes: [{ part: '1.1', type: 'text/plain', encoding: '8bit' }],
        },
        { part: '2', type: 'application/pdf' },
      ],
    });

    expect(part?.key).toBe('1.1');
    expect(part?.type).toBe('text/plain');
  });

  it('gives up rather than guessing when section 1 is not text', () => {
    expect(
      findPreviewPart({
        type: 'multipart/mixed',
        childNodes: [{ part: '1', type: 'image/png' }],
      }),
    ).toBeUndefined();
  });

  it('gives up on a nested multipart with no text at 1.1', () => {
    expect(
      findPreviewPart({
        type: 'multipart/mixed',
        childNodes: [{ part: '1', type: 'multipart/related', childNodes: [] }],
      }),
    ).toBeUndefined();
  });

  it('returns undefined for a missing structure', () => {
    expect(findPreviewPart(undefined)).toBeUndefined();
    expect(findPreviewPart(null)).toBeUndefined();
  });
});

describe('buildPreview', () => {
  const plain = { key: '1', type: 'text/plain', encoding: '8bit', charset: 'utf-8' };

  it('collapses whitespace in plain text', () => {
    expect(buildPreview(Buffer.from('Hello\r\n\r\n  there'), plain)).toBe('Hello there');
  });

  const html = { key: '1', type: 'text/html', encoding: '8bit', charset: 'utf-8' };

  it('strips markup when only an HTML part exists', () => {
    const body = '<p>Hello <b>there</b>, this is the actual message body.</p>';

    expect(buildPreview(Buffer.from(body), html)).toBe(
      'Hello there, this is the actual message body.',
    );
  });

  // The opening kilobyte of an HTML mail is head boilerplate. Stripping it can
  // leave a few stray characters, which is worse than showing nothing.
  it('returns undefined when markup yields only residue', () => {
    const boilerplate = '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>';

    expect(buildPreview(Buffer.from(boilerplate), html)).toBeUndefined();
  });

  // Bulk senders routinely put markup in the part they declare as text/plain.
  it('strips markup from a part the sender mislabelled as text/plain', () => {
    const body = '<style>html{margin:0}</style><div>The actual message text goes here.</div>';

    expect(buildPreview(Buffer.from(body), plain)).toBe('The actual message text goes here.');
  });

  it('decodes numeric entities', () => {
    const body = '<p>caf&#233; and 5&#x26;6, a message long enough to keep</p>';

    expect(buildPreview(Buffer.from(body), html)).toBe(
      'café and 5&6, a message long enough to keep',
    );
  });

  it('drops an unterminated Outlook conditional comment', () => {
    const body = '<p>Real message content here</p><!--[if mso]><table';

    expect(buildPreview(Buffer.from(body), html)).toBe('Real message content here');
  });

  it('leaves angle-bracket URLs alone in genuine plain text', () => {
    const body = 'See the site <http://example.com/page> for the details.';

    expect(buildPreview(Buffer.from(body), plain)).toBe(body);
  });

  it('still shows a genuinely short plain-text message', () => {
    expect(buildPreview(Buffer.from('Ok, thanks'), plain)).toBe('Ok, thanks');
  });

  it('truncates with an ellipsis and no dangling space', () => {
    const preview = buildPreview(Buffer.from('word '.repeat(200)), plain);

    expect(preview?.length ?? 0).toBeLessThanOrEqual(PREVIEW_LENGTH + 1);
    expect(preview?.endsWith('…')).toBe(true);
    expect(preview).not.toContain(' …');
  });

  it('returns undefined for an empty body rather than an empty string', () => {
    expect(buildPreview(Buffer.from('   \r\n  '), plain)).toBeUndefined();
  });

  it('drops the replacement character left by a truncated character', () => {
    const raw = Buffer.from('caf=C3');

    expect(buildPreview(raw, { ...plain, encoding: 'quoted-printable' })).toBe('caf');
  });

  it('decodes through both layers at once', () => {
    const raw = Buffer.from('caf=E9 au lait');
    const latin = {
      key: '1',
      type: 'text/plain',
      encoding: 'quoted-printable',
      charset: 'iso-8859-1',
    };

    expect(buildPreview(raw, latin)).toBe('café au lait');
  });
});
