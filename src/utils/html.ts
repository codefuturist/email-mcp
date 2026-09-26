/**
 * HTML-to-text conversion for email bodies.
 *
 * Most mail arrives as HTML — 165 of 169 messages in one real mailbox were
 * single-part `text/html` — so this runs on nearly every body the server
 * returns, and undecoded entities show up directly in what the model reads.
 */

/**
 * Named entities worth carrying.
 *
 * The full HTML5 set runs to ~2,000 names, which is not worth embedding for
 * email. This covers the XML five, the Latin-1 letters that German and French
 * senders rely on, and the typographic punctuation that mail composers emit
 * constantly (curly quotes, dashes, ellipsis, zero-width and soft hyphens).
 */
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  shy: '­',
  zwnj: '‌',
  zwj: '‍',
  // Typographic punctuation
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  bull: '•',
  middot: '·',
  laquo: '«',
  raquo: '»',
  // Arrows — common in newsletter call-to-action links ("Read more &rarr;")
  larr: '←',
  uarr: '↑',
  rarr: '→',
  darr: '↓',
  harr: '↔',
  // Symbols
  copy: '©',
  reg: '®',
  trade: '™',
  euro: '€',
  pound: '£',
  deg: '°',
  times: '×',
  // Latin-1 letters
  auml: 'ä',
  ouml: 'ö',
  uuml: 'ü',
  Auml: 'Ä',
  Ouml: 'Ö',
  Uuml: 'Ü',
  szlig: 'ß',
  agrave: 'à',
  aacute: 'á',
  acirc: 'â',
  aring: 'å',
  aelig: 'æ',
  ccedil: 'ç',
  egrave: 'è',
  eacute: 'é',
  ecirc: 'ê',
  euml: 'ë',
  igrave: 'ì',
  iacute: 'í',
  ntilde: 'ñ',
  ograve: 'ò',
  oacute: 'ó',
  ocirc: 'ô',
  oslash: 'ø',
  ugrave: 'ù',
  uacute: 'ú',
};

/** Matches a named, decimal or hexadecimal character reference. */
const ENTITY_PATTERN = /&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|([a-zA-Z][a-zA-Z0-9]*));/g;

/**
 * Decode HTML character references.
 *
 * Single pass by design: decoding repeatedly would turn the literal text
 * `&amp;lt;` into `<`, when it means the four characters `&lt;`.
 */
export function decodeEntities(text: string): string {
  return text.replace(ENTITY_PATTERN, (match, dec: string, hex: string, name: string) => {
    if (dec !== undefined || hex !== undefined) {
      const code = dec !== undefined ? Number.parseInt(dec, 10) : Number.parseInt(hex, 16);
      // Surrogate halves and anything past the Unicode range would make
      // String.fromCodePoint throw; leave those as written.
      if (!Number.isFinite(code) || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
        return match;
      }
      return String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[name] ?? match;
  });
}

/**
 * Invisible formatting characters with no semantic role in an email body.
 *
 * Bulk senders pad the inbox preview line with hundreds of these — zero-width
 * spaces, soft hyphens, combining grapheme joiners. They render as nothing but
 * a model still spends tokens reading them, and they keep otherwise-blank
 * lines from collapsing.
 *
 * Deliberately excludes ZWNJ (U+200C) and ZWJ (U+200D): both are meaningful,
 * ZWJ most visibly in emoji sequences, where dropping it splits a family
 * emoji into separate people.
 */
// Written as an alternation rather than a character class: U+034F is a
// combining mark, and inside a class it can bind to a neighbouring character.
// Escapes rather than literals so the set is visible when reading the source.
const INVISIBLE_PADDING = /\u200B|\u00AD|\u034F|\u2060|\uFEFF/g; // ZWSP, soft hyphen, CGJ, word joiner, BOM

/**
 * Zero-width joiners used as spacing rather than as text.
 *
 * ZWNJ and ZWJ are semantic between letters — ZWJ composes emoji sequences,
 * ZWNJ blocks ligatures in Persian and Indic scripts — so they cannot be
 * removed outright. Used as preview padding they appear next to whitespace or
 * in runs, never between two letters, which is what this matches.
 */
const JOINER_PADDING = /(?<![^\s])[\u200C\u200D]+(?=[\s\u200C\u200D]|$)|(?<=\s)[\u200C\u200D]+/g;

/**
 * Convert an HTML body to readable plain text.
 *
 * Block-level elements become line breaks so paragraph structure survives;
 * everything else is dropped. Entities are decoded before padding is removed,
 * since the padding usually arrives entity-encoded — and after tags are gone,
 * so an entity-encoded angle bracket can never be mistaken for markup.
 */
export function stripHtml(html: string): string {
  const withoutMarkup = html
    // Elements whose text is machinery, not content. Dropping the tags alone
    // would leave their values inline — Outlook-authored mail otherwise opens
    // with "96" from <o:PixelsPerInch>.
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<xml[^>]*>[\s\S]*?<\/xml>/gi, '')
    .replace(/<title[^>]*>[\s\S]*?<\/title>/gi, '')
    // Conditional comments carry a whole alternate layout for Outlook.
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n• ')
    .replace(/<[^>]+>/g, '');

  return (
    decodeEntities(withoutMarkup)
      .replace(INVISIBLE_PADDING, '')
      .replace(JOINER_PADDING, '')
      // U+00A0 is the correct decoding of &nbsp;, but layout tables emit rows
      // of them. Treat it as ordinary whitespace here so those lines collapse;
      // one sitting inside a sentence ("10 CHF") is left as a single space.
      .replace(/ /g, ' ')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}
