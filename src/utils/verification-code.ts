/**
 * Verification-code (OTP/2FA) extraction from email subject + plain body text.
 *
 * A bare `\d{6}` regex matches order numbers, phone fragments, years, and
 * prices, so extraction is two-phase instead: generate shaped candidates,
 * then score each by keyword proximity (English + German) minus negative
 * context and shape penalties. Only candidates clearing a threshold are
 * returned — no hit is better than a wrong hit landing on the clipboard.
 *
 * The caller is responsible for preparing `bodyText`
 * (`bodyText ?? stripHtml(bodyHtml)`, then `stripReplyChain`).
 */

export interface VerificationCodeMatch {
  /** Canonical code to copy/paste (separators stripped, `G-` prefix removed). */
  code: string;
  /** The code exactly as it appeared in the mail. */
  display: string;
  confidence: 'high' | 'medium' | 'low';
  score: number;
  /** Trimmed line the code was found on (≤120 chars) — never log this blindly. */
  evidence: string;
  source: 'subject' | 'body';
}

// Scan caps — verification mails are short; anything beyond this is boilerplate.
const MAX_BODY_CHARS = 20_000;
const MAX_BODY_LINES = 200;

const ACCEPT_THRESHOLD = 5;
const KEYWORD_CAP = 6;
const NEGATIVE_CAP = -10;

// ---------------------------------------------------------------------------
// Candidate shapes
// ---------------------------------------------------------------------------

interface CandidatePattern {
  re: RegExp;
  base: number | ((raw: string) => number);
  canonical: (raw: string, groups: string[]) => string;
}

// Boundary guards: candidates must not sit inside a longer digit/word run
// (tracking numbers, IBANs, hex hashes). `\b` can't express this because
// digits are word characters.
const G = '(?<![A-Za-z0-9_-])';
const GE = '(?![A-Za-z0-9_-])';

const CANDIDATE_PATTERNS: CandidatePattern[] = [
  // Service-prefixed, e.g. Google's "G-482913". Google's prefix is branding,
  // the pasteable code is the digits; other prefixes are part of the code.
  {
    re: new RegExp(`${G}([A-Z]{1,2})-(\\d{5,8})${GE}`, 'g'),
    base: 3,
    canonical: (raw, groups) => (groups[0] === 'G' ? (groups[1] ?? raw) : raw),
  },
  // Grouped digits, e.g. Apple's "123 456" — one code, joined.
  {
    re: new RegExp(`${G}(\\d{3}[- ]\\d{3})${GE}`, 'g'),
    base: 3,
    canonical: (raw) => raw.replace(/[- ]/g, ''),
  },
  // Plain digit runs. Six digits is the overwhelmingly common OTP length.
  {
    re: new RegExp(`${G}(\\d{4,8})${GE}`, 'g'),
    base: (raw) => (raw.length === 6 ? 3 : 2),
    canonical: (raw) => raw,
  },
  // Uppercase alphanumeric ("7K3M9Q") — weakest shape, needs strong context.
  {
    re: new RegExp(`${G}([A-Z0-9]{5,8})${GE}`, 'g'),
    base: 1,
    canonical: (raw) => raw,
  },
];

// ---------------------------------------------------------------------------
// Keyword tables (checked against lowercased context windows)
// ---------------------------------------------------------------------------

const STRONG_KEYWORDS: RegExp[] = [
  /verification/,
  /security code/,
  /login code/,
  /sign.?in code/,
  /auth(?:entication)? code/,
  /confirmation code/,
  /\botp\b/,
  /\b2fa\b/,
  /two.?factor/,
  /passcode/,
  /one.?time/,
  /\bpin\b/,
  /is your/,
  /use (?:this )?code/,
  /enter (?:this |the )?code/,
  /code is/,
  // German
  /bestätigungscode/,
  /sicherheitscode/,
  /einmalpasswort/,
  /einmalkennwort/,
  /einmal.?code/,
  /anmeldecode/,
  /verifizierungscode/,
  /\btan\b/,
  /code lautet/,
  /ihr code/,
  /dein code/,
  /ist ihr/,
  /ist dein/,
];

const WEAK_KEYWORDS: RegExp[] = [
  /\bcode\b/,
  /expire/,
  /valid for/,
  /minutes?/,
  /sign.?in/,
  /log.?in/,
  /confirm/,
  /account/,
  // German
  /gültig/,
  /minuten/,
  /anmeld/,
  /bestätig/,
  /\bkonto\b/,
  /läuft ab/,
];

// Presence of any of these near a candidate means the number identifies
// something (an order, a parcel, a meeting) rather than authenticating someone.
const NEGATIVE_KEYWORDS: RegExp[] = [
  /order/,
  /invoice/,
  /receipt/,
  /tracking/,
  /shipment/,
  /delivery/,
  /ticket/,
  /case number/,
  /reference number/,
  /customer number/,
  /\biban\b/,
  /amount/,
  /\btotal\b/,
  /price/,
  /meeting.?id/,
  /webinar/,
  /\bdial\b/,
  /conference/,
  /zoom\.us/,
  /teams\.microsoft/,
  // German
  /bestell/,
  /auftrag/,
  /rechnung/,
  /sendung/,
  /liefer/,
  /kundennummer/,
  /betrag/,
  /summe/,
  /artikel/,
];

const STREET_RE = /str\.|stra?sse|straße|street|avenue|\bave\b|postfach/;
const CURRENCY_RE = /[€$£]|\bchf\b|\beur\b|\busd\b|\bgbp\b/;
const DATE_RE = /\d{1,2}[./]\d{1,2}[./]\d{2,4}/g;
const PHONE_RUN_CHARS = /[\d\s().-]/;

// ---------------------------------------------------------------------------

interface Candidate {
  canonical: string;
  display: string;
  score: number;
  lineIdx: number;
  start: number;
  end: number;
  source: 'subject' | 'body';
  evidence: string;
  strongDistance: number;
}

function keywordScore(window: string): number {
  let sum = 0;
  for (const re of STRONG_KEYWORDS) if (re.test(window)) sum += 4;
  for (const re of WEAK_KEYWORDS) if (re.test(window)) sum += 2;
  return Math.min(sum, KEYWORD_CAP);
}

function negativeScore(window: string): number {
  let sum = 0;
  for (const re of NEGATIVE_KEYWORDS) if (re.test(window)) sum -= 5;
  return Math.max(sum, NEGATIVE_CAP);
}

/** Digits in the contiguous phone-ish run ([\d\s().-]) around the match. */
function surroundingDigitRun(line: string, start: number, end: number): string {
  let lo = start;
  while (lo > 0 && PHONE_RUN_CHARS.test(line[lo - 1] as string)) lo -= 1;
  let hi = end;
  while (hi < line.length && PHONE_RUN_CHARS.test(line[hi] as string)) hi += 1;
  return line.slice(lo, hi);
}

function shapePenalty(canonical: string, line: string, start: number, end: number): number {
  let penalty = 0;

  if (/^(?:19|20)\d{2}$/.test(canonical)) penalty -= 3;

  const run = surroundingDigitRun(line, start, end);
  const runDigits = (run.match(/\d/g) ?? []).length;
  if (run.trimStart().startsWith('+') || runDigits >= 9) penalty -= 5;

  for (const m of line.matchAll(DATE_RE)) {
    const mStart = m.index;
    if (mStart <= start && mStart + m[0].length >= end) {
      penalty -= 4;
      break;
    }
  }

  const vicinity = line.slice(Math.max(0, start - 8), Math.min(line.length, end + 8));
  if (CURRENCY_RE.test(vicinity.toLowerCase())) penalty -= 5;

  if (STREET_RE.test(line.toLowerCase())) penalty -= 3;

  return penalty;
}

function collectLineCandidates(
  line: string,
): { start: number; end: number; display: string; canonical: string; base: number }[] {
  const found: { start: number; end: number; display: string; canonical: string; base: number }[] =
    [];
  for (const pattern of CANDIDATE_PATTERNS) {
    pattern.re.lastIndex = 0;
    for (const m of line.matchAll(pattern.re)) {
      const display = m[1] && m[2] ? m[0] : (m[1] ?? m[0]);
      const start = m.index;
      const end = start + m[0].length;
      // Higher-priority shapes claim their span first (e.g. "G-482913"
      // must not additionally yield a bare "482913").
      if (found.some((f) => start < f.end && end > f.start)) continue;
      const canonical = pattern.canonical(
        m[0],
        m.slice(1).filter((g): g is string => g !== undefined),
      );
      // Alphanumeric shape must mix letters and digits — pure-letter tokens
      // are words, pure-digit tokens belong to the digit patterns.
      if (!/\d/.test(canonical)) continue;
      const base = typeof pattern.base === 'function' ? pattern.base(m[0]) : pattern.base;
      found.push({ start, end, display, canonical, base });
    }
  }
  return found;
}

/** Previous non-empty line, looking back at most two lines (one blank allowed). */
function prevContextLine(lines: string[], idx: number): string {
  for (let i = idx - 1; i >= Math.max(0, idx - 2); i -= 1) {
    const line = lines[i] ?? '';
    if (line.trim() !== '') return line;
  }
  return '';
}

function minStrongDistance(window: string, candidateDisplay: string): number {
  const pos = window.indexOf(candidateDisplay);
  if (pos === -1) return Number.POSITIVE_INFINITY;
  let best = Number.POSITIVE_INFINITY;
  for (const re of STRONG_KEYWORDS) {
    const m = window.match(re);
    if (m?.index !== undefined) best = Math.min(best, Math.abs(m.index - pos));
  }
  return best;
}

/**
 * Extract the most likely verification code. Returns `undefined` when no
 * candidate clears the acceptance threshold.
 */
export function extractVerificationCode(
  subject: string,
  bodyText: string,
): VerificationCodeMatch | undefined {
  const body = bodyText.slice(0, MAX_BODY_CHARS);
  const bodyLines = body.split('\n').slice(0, MAX_BODY_LINES);

  const lowerSubject = subject.toLowerCase();
  const subjectHasStrong = STRONG_KEYWORDS.some((re) => re.test(lowerSubject));

  const candidates: Candidate[] = [];

  const scoreLine = (
    line: string,
    lineIdx: number,
    source: 'subject' | 'body',
    positiveWindow: string,
    negativeWindow: string,
  ): void => {
    for (const raw of collectLineCandidates(line)) {
      const lowerPositive = positiveWindow.toLowerCase();
      let score = raw.base;
      score += keywordScore(lowerPositive);
      score += negativeScore(negativeWindow.toLowerCase());
      score += shapePenalty(raw.canonical, line, raw.start, raw.end);
      if (source === 'subject') score += 2;
      else if (subjectHasStrong) score += 2;

      candidates.push({
        canonical: raw.canonical,
        display: raw.display,
        score,
        lineIdx,
        start: raw.start,
        end: raw.end,
        source,
        evidence: line.trim().slice(0, 120),
        strongDistance: minStrongDistance(lowerPositive, raw.display.toLowerCase()),
      });
    }
  };

  scoreLine(subject, -1, 'subject', subject, subject);

  bodyLines.forEach((line, idx) => {
    if (line.trim() === '') return;
    // Positive context may skip one blank line backwards ("Enter this code:"
    // ↵ blank ↵ "482913"); negative context stays strictly adjacent so an
    // unrelated paragraph above cannot poison a legitimate code below it.
    const positiveWindow = [prevContextLine(bodyLines, idx), line, bodyLines[idx + 1] ?? ''].join(
      '\n',
    );
    const negativeWindow = [bodyLines[idx - 1] ?? '', line, bodyLines[idx + 1] ?? ''].join('\n');
    scoreLine(line, idx, 'body', positiveWindow, negativeWindow);
  });

  // Same code found in several places keeps its best-scoring occurrence.
  const byCanonical = new Map<string, Candidate>();
  for (const c of candidates) {
    const existing = byCanonical.get(c.canonical);
    if (!existing || c.score > existing.score) byCanonical.set(c.canonical, c);
  }

  const best = [...byCanonical.values()]
    .filter((c) => c.score >= ACCEPT_THRESHOLD)
    .sort(
      (a, b) =>
        b.score - a.score ||
        (a.source === 'subject' ? -1 : 0) - (b.source === 'subject' ? -1 : 0) ||
        a.strongDistance - b.strongDistance ||
        a.lineIdx - b.lineIdx ||
        a.start - b.start,
    )[0];

  if (!best) return undefined;

  const confidence: VerificationCodeMatch['confidence'] =
    best.score >= 8 ? 'high' : best.score >= 6 ? 'medium' : 'low';

  return {
    code: best.canonical,
    display: best.display,
    confidence,
    score: best.score,
    evidence: best.evidence,
    source: best.source,
  };
}
