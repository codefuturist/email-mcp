/**
 * Build a short text preview from a partially fetched message body.
 *
 * Listings fetch only the first few hundred bytes of one body part, so every
 * step here has to tolerate input that is cut mid-encoding: a base64 stream
 * truncated off a 4-byte boundary, or a quoted-printable escape sliced in half.
 */

/**
 * Bytes fetched per message for the preview, before decoding.
 *
 * Measured against 80 live messages: plain text is usable from 600 bytes, but
 * HTML mail spends its opening kilobyte on head boilerplate — usable previews
 * go from 11/27 at 600 bytes to 25/27 at 1500, and gain nothing beyond that.
 */
export const PREVIEW_PART_BYTES = 1500;

/**
 * Markup in a part the sender declared as text/plain. Bulk senders do this
 * often enough that trusting the declared type leaves CSS in the preview.
 */
const LOOKS_LIKE_MARKUP = /<(?:html|body|div|table|style|head|meta|span|p|br)\b/i;

/**
 * Below this many characters, a preview built from markup is residue rather
 * than content. Plain text is exempt: a short message is still worth showing.
 */
const MIN_MARKUP_PREVIEW = 20;

/** Characters kept in the finished preview. */
export const PREVIEW_LENGTH = 200;

/** Strip tags and decode the handful of entities that survive tag removal. */
export function stripHtml(html: string): string {
  return (
    html
      .replace(/<!DOCTYPE[^>]*>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      // Outlook conditional comments are routinely cut off unterminated.
      .replace(/<!--[\s\S]*$/, ' ')
      // The head of an HTML mail is meta and link tags — never content.
      .replace(/<head[\s\S]*?<\/head>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      // A truncated fetch can end inside a style, script or head block, leaving
      // no closing tag for the rules above to match.
      .replace(/<(?:style|script|head)\b[\s\S]*$/i, ' ')
      .replace(/<[^>]+>/g, ' ')
      // …and can equally end inside an ordinary tag, which would otherwise
      // survive tag removal and show up as "<meta name=" in the preview.
      .replace(/<[^>]*$/, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
      .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(parseInt(code, 16)))
      .replace(/\s+/g, ' ')
      // Every tag becomes a space, so "<b>word</b>," would read "word ,".
      .replace(/ +([,.;:!?)\]])/g, '$1')
      .trim()
  );
}

/** Decode quoted-printable, discarding an escape the truncation cut in half. */
function decodeQuotedPrintable(raw: Buffer): Buffer {
  const text = raw
    .toString('latin1')
    // Soft line breaks join the line to the next one.
    .replace(/=\r?\n/g, '')
    // A trailing "=" or "=A" is the start of an escape we did not fetch.
    .replace(/=[0-9A-Fa-f]?$/, '');

  const out: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '=' && i + 2 < text.length) {
      const hex = text.slice(i + 1, i + 3);
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        out.push(parseInt(hex, 16));
        i += 2;
      } else {
        out.push(text.charCodeAt(i));
      }
    } else {
      out.push(text.charCodeAt(i));
    }
  }
  return Buffer.from(out);
}

/** Decode base64, dropping the trailing bytes that do not form a whole group. */
function decodeBase64(raw: Buffer): Buffer {
  const cleaned = raw.toString('latin1').replace(/[^A-Za-z0-9+/=]/g, '');
  const whole = cleaned.slice(0, cleaned.length - (cleaned.length % 4));
  return Buffer.from(whole, 'base64');
}

/** Undo the part's Content-Transfer-Encoding. */
export function decodeTransferEncoding(raw: Buffer, encoding: string | undefined): Buffer {
  switch ((encoding ?? '').toLowerCase()) {
    case 'quoted-printable':
      return decodeQuotedPrintable(raw);
    case 'base64':
      return decodeBase64(raw);
    default:
      // 7bit, 8bit, binary, or unspecified — the bytes are already the content.
      return raw;
  }
}

/**
 * Decode bytes with the part's declared charset.
 *
 * `fatal: false` matters: the fetch cuts the body mid-character often enough
 * that a strict decoder would throw on ordinary mail.
 */
export function decodeCharset(buffer: Buffer, charset: string | undefined): string {
  const label = (charset ?? 'utf-8').toLowerCase();
  try {
    return new TextDecoder(label, { fatal: false }).decode(buffer);
  } catch {
    // Unknown label — TextDecoder throws on construction, not on decode.
    return buffer.toString('utf-8');
  }
}

/** The body part a preview should be built from. */
export interface PreviewPart {
  /** IMAP section number to fetch. */
  key: string;
  type: string;
  encoding?: string;
  charset?: string;
}

interface StructureNode {
  part?: string;
  type?: string;
  encoding?: string;
  parameters?: { charset?: string };
  childNodes?: StructureNode[];
}

function toPart(node: StructureNode, key: string): PreviewPart | undefined {
  if (!node.type?.startsWith('text/')) {
    return undefined;
  }
  return { key, type: node.type, encoding: node.encoding, charset: node.parameters?.charset };
}

/**
 * Decide which section to fetch for the preview.
 *
 * Section 1 is the body of a single-part message and the first alternative of a
 * multipart, which covers the overwhelming majority of mail. When section 1 is
 * itself a multipart — around 4% of messages in practice — the text sits at
 * 1.1, which callers must fetch in a second pass restricted to those messages:
 * asking for a section a message does not have fails the whole batch on Gmail.
 */
export function findPreviewPart(bodyStructure: unknown): PreviewPart | undefined {
  if (!bodyStructure || typeof bodyStructure !== 'object') {
    return undefined;
  }
  const root = bodyStructure as StructureNode;
  const first = root.childNodes?.find((child) => child.part === '1') ?? root;

  if (!first.type?.startsWith('multipart')) {
    return toPart(first, '1');
  }

  const nested = first.childNodes?.find((child) => child.part === '1.1');
  return nested ? toPart(nested, '1.1') : undefined;
}

/** Decode a fetched part into a one-line preview, or undefined if it is empty. */
export function buildPreview(raw: Buffer, part: PreviewPart): string | undefined {
  const decoded = decodeCharset(decodeTransferEncoding(raw, part.encoding), part.charset);
  // Trust the content over the declared type: a text/plain part carrying markup
  // would otherwise put raw CSS in the preview.
  const isMarkup = part.type === 'text/html' || LOOKS_LIKE_MARKUP.test(decoded);
  const text = (isMarkup ? stripHtml(decoded) : decoded.replace(/\s+/g, ' ').trim())
    // The fetch can end mid-character: a complete "=C3" escape is still an
    // incomplete UTF-8 sequence, which decodes to U+FFFD. That is truncation
    // damage, not content.
    .replace(/\uFFFD+\s*$/, '')
    .trimEnd();

  if (text.length < (isMarkup ? MIN_MARKUP_PREVIEW : 1)) {
    return undefined;
  }
  return text.length > PREVIEW_LENGTH ? `${text.slice(0, PREVIEW_LENGTH).trimEnd()}…` : text;
}
