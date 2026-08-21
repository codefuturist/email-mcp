import { decodeEntities, stripHtml } from './html.js';

describe('decodeEntities', () => {
  it('decodes named entities', () => {
    expect(decodeEntities('a &amp; b &lt;c&gt; &quot;d&quot;')).toBe('a & b <c> "d"');
  });

  it('decodes Latin-1 letters used by German senders', () => {
    // Seen verbatim in real mail: "am n&auml;chsten Werktag".
    expect(decodeEntities('n&auml;chsten Gr&uuml;&szlig;e')).toBe('nächsten Grüße');
  });

  it('decodes decimal numeric entities', () => {
    // Zero-width spaces and soft hyphens are sprinkled through marketing mail.
    expect(decodeEntities('a&#8203;b&#847;c')).toBe('a​b͏c');
  });

  it('decodes hexadecimal numeric entities', () => {
    expect(decodeEntities('&#x2019;')).toBe('’');
  });

  it('decodes typographic punctuation', () => {
    expect(decodeEntities('We&rsquo;re &mdash; here&hellip;')).toBe('We’re — here…');
  });

  it('does not re-decode the output of a previous decode', () => {
    // "&amp;lt;" means the literal text "&lt;", not "<". Decoding in
    // sequential passes would wrongly produce "<".
    expect(decodeEntities('&amp;lt;')).toBe('&lt;');
  });

  it('leaves unknown entities untouched', () => {
    expect(decodeEntities('&notarealentity; &#;')).toBe('&notarealentity; &#;');
  });

  it('rejects out-of-range code points rather than throwing', () => {
    expect(decodeEntities('&#1114112;')).toBe('&#1114112;');
  });
});

describe('stripHtml — non-content markup', () => {
  it('drops Office document settings', () => {
    // Outlook-authored mail opens with an XML island; stripping only the tags
    // leaves its values ("96") as the first thing the model reads.
    const html =
      '<xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch>' +
      '</o:OfficeDocumentSettings></xml><p>Real content</p>';
    expect(stripHtml(html)).toBe('Real content');
  });

  it('drops conditional comments', () => {
    expect(stripHtml('<!--[if mso]><table><tr><td>hidden<![endif]--><p>shown</p>')).toBe('shown');
  });

  it('drops the document title', () => {
    expect(stripHtml('<head><title>Newsletter #42</title></head><p>body</p>')).toBe('body');
  });

  it('decodes arrow entities', () => {
    expect(decodeEntities('Read more &rarr;')).toBe('Read more →');
  });
});

describe('stripHtml — invisible characters', () => {
  it('removes zero-width and soft-hyphen padding', () => {
    // Marketing mail pads the inbox preview line with hundreds of these.
    // Decoded they are invisible, but a model still pays tokens to read them.
    const padded = `Real text${'͏​­'.repeat(30)}`;
    expect(stripHtml(padded)).toBe('Real text');
  });

  it('keeps zero-width joiners, which carry meaning', () => {
    // ZWJ composes emoji sequences; dropping it splits 👨‍👩‍👧 into three people.
    expect(stripHtml('<p>👨‍👩‍👧</p>')).toBe('👨‍👩‍👧');
  });

  it('keeps a zero-width non-joiner sitting between letters', () => {
    // Semantic in Persian and Indic scripts: it prevents ligature forming.
    expect(stripHtml('<p>می‌رود</p>')).toBe('می‌رود');
  });

  it('removes zero-width joiners used as preview padding', () => {
    // Padding puts them between spaces; real usage puts them between letters.
    expect(stripHtml('<p>‌ ‌ ‌ ‌ ‌ Werden diese E-Mail</p>')).toBe('Werden diese E-Mail');
  });

  it('collapses the blank lines that padding leaves behind', () => {
    expect(stripHtml('<p>a</p>​​\n​\n​\n<p>b</p>')).toBe('a\n\nb');
  });

  it('treats non-breaking spaces as whitespace when collapsing', () => {
    // decodeEntities correctly yields U+00A0 for &nbsp;, but layout tables
    // emit rows of them; without normalizing, those lines never collapse.
    expect(stripHtml('a<br>&nbsp;&nbsp;&nbsp;<br>&nbsp;<br>b')).toBe('a\n\nb');
  });

  it('keeps a non-breaking space inside a sentence, as an ordinary space', () => {
    // Asserted via escape on purpose: a literal U+00A0 here is invisible in
    // the diff and makes any failure unreadable.
    expect(stripHtml('<p>10&nbsp;CHF</p>')).toBe('10\u0020CHF');
  });
});

describe('stripHtml', () => {
  it('removes tags and collapses block elements into newlines', () => {
    expect(stripHtml('<p>one</p><p>two</p>')).toBe('one\n\ntwo');
  });

  it('drops style and script content', () => {
    expect(stripHtml('<style>p{color:red}</style><p>visible</p>')).toBe('visible');
  });

  it('decodes entities in the stripped output', () => {
    expect(stripHtml('<p>We&rsquo;re at n&auml;chsten</p>')).toBe('We’re at nächsten');
  });

  it('renders list items as bullets', () => {
    expect(stripHtml('<ul><li>a</li><li>b</li></ul>')).toBe('• a\n• b');
  });
});
