/**
 * RFC 5322 header parsing.
 *
 * Used for both bulk-mail classification and sender-authentication signals, so
 * it has to be right about the two things naive parsers get wrong: folded
 * fields, and fields that legitimately appear more than once.
 */

/**
 * Parse a raw header block into lowercased keys.
 *
 * Continuation lines are unfolded per §2.2.3 — a folded `List-Unsubscribe` or
 * `Authentication-Results` is otherwise truncated to its first line, which for
 * the latter discards every SPF, DKIM and DMARC result it carries.
 *
 * A field appearing several times is joined with a newline rather than
 * overwritten: `Authentication-Results` and `Received` appear once per relay
 * hop, and keeping only the last one loses the rest.
 */
export default function parseHeaderBlock(raw: string): Record<string, string> {
  const allLines = raw.split(/\r?\n/);
  // A blank line ends the header block; everything after it is body.
  const blankIndex = allLines.findIndex((line) => line.length === 0);
  const lines = blankIndex >= 0 ? allLines.slice(0, blankIndex) : allLines;

  // Unfold: a line starting with whitespace continues the field above it.
  const fields = lines.reduce<string[]>((acc, line) => {
    if (/^[ \t]/.test(line) && acc.length > 0) {
      acc[acc.length - 1] = `${acc[acc.length - 1]} ${line.trim()}`.trim();
    } else {
      acc.push(line);
    }
    return acc;
  }, []);

  return fields.reduce<Record<string, string>>((acc, line) => {
    const colonIndex = line.indexOf(':');
    if (colonIndex <= 0) {
      return acc;
    }
    const key = line.slice(0, colonIndex).trim().toLowerCase();
    const value = line.slice(colonIndex + 1).trim();
    if (key && value) {
      const existing = acc[key];
      acc[key] = existing ? `${existing}\n${value}` : value;
    }
    return acc;
  }, {});
}
