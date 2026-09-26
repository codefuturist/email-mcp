/**
 * Glob-style pattern matching for rule configuration values
 * (hook rules, sender allow/denylists).
 */

/** Convert a glob-like pattern (with `*` wildcards and `|` OR) to a RegExp. */
export function globToRegex(pattern: string): RegExp {
  const parts = pattern
    .split('|')
    .map((p) => p.trim())
    .filter(Boolean);
  const regexParts = parts.map((part) => {
    const escaped = part.replace(/[.+?^${}()[\]\\]/g, '\\$&');
    return escaped.replace(/\*/g, '.*');
  });
  return new RegExp(`^(?:${regexParts.join('|')})$`, 'i');
}

/** Test whether a value matches a glob pattern (case-insensitive). */
export function matchesPattern(pattern: string, value: string): boolean {
  try {
    return globToRegex(pattern).test(value);
  } catch {
    return false;
  }
}
