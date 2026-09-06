/**
 * Build a short text preview from a partially fetched message body.
 *
 * Listings fetch only the first few hundred bytes of one body part, so every
 * step here has to tolerate input that is cut mid-encoding: a base64 stream
 * truncated off a 4-byte boundary, or a quoted-printable escape sliced in half.
 */

/** Bytes fetched per message for the preview. Raw, before decoding. */
export const PREVIEW_PART_BYTES = 600;

/** Characters kept in the finished preview. */
export const PREVIEW_LENGTH = 200;

/** Strip tags and decode the handful of entities that survive tag removal. */
export function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
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
  const text = (
    part.type === 'text/html' ? stripHtml(decoded) : decoded.replace(/\s+/g, ' ').trim()
  )
    // The fetch can end mid-character: a complete "=C3" escape is still an
    // incomplete UTF-8 sequence, which decodes to U+FFFD. That is truncation
    // damage, not content.
    .replace(/\uFFFD+\s*$/, '')
    .trimEnd();

  if (text.length === 0) {
    return undefined;
  }
  return text.length > PREVIEW_LENGTH ? `${text.slice(0, PREVIEW_LENGTH).trimEnd()}…` : text;
}
