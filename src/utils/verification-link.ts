/**
 * Sign-in "magic link" extraction from email bodies.
 *
 * HTML is parsed for anchors BEFORE any stripHtml pass (stripHtml discards
 * hrefs). Every anchor is scored on URL keywords, opaque-token presence,
 * anchor-text wording (EN/DE), and sender-domain affiliation; boilerplate
 * (unsubscribe, privacy, social footers) is rejected outright. Plain-text
 * bodies get the same URL scoring on bare URLs — a first-class path, since
 * getEmail() yields either a text or an HTML body, never both.
 */

import { stripHtml } from './html.js';

export interface MagicLinkMatch {
  link: string;
  anchorText?: string;
  score: number;
  source: 'html' | 'text';
}

const ACCEPT_THRESHOLD = 4;
const URL_KEYWORD_CAP = 6;

const ANCHOR_RE = /<a\b[^>]*?href\s*=\s*(?:"([^"]+)"|'([^']+)')[^>]*>([\s\S]*?)<\/a>/gi;
const BARE_URL_RE = /https?:\/\/[^\s<>"')\]]+/g;
const TRAILING_PUNCT_RE = /[.,;:!?)>\]'"]+$/;

// A path segment or query value carrying ≥20 url-safe chars is almost
// certainly a one-time token rather than human-readable navigation.
const OPAQUE_TOKEN_RE = /[A-Za-z0-9_-]{20,}/;

const URL_KEYWORDS = [
  'verify',
  'verification',
  'confirm',
  'confirmation',
  'activate',
  'activation',
  'magic',
  'magiclink',
  'magic-link',
  'signin',
  'sign-in',
  'login',
  'log-in',
  'auth',
  'authenticate',
  'sso',
  'token',
  'otp',
  'one-time',
  'onetime',
  'passwordless',
  'passkey',
  'reset',
  'callback',
].map((w) => new RegExp(`(?<![a-z0-9])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9])`));

const ANCHOR_KEYWORDS = [
  'verify',
  'confirm',
  'sign in',
  'log in',
  'login',
  'activate',
  'continue',
  'access',
  'get started',
  // German
  'bestätigen',
  'anmelden',
  'einloggen',
  'aktivieren',
  'weiter',
  'zugang',
];

// Boilerplate that is never the mail's call to action.
const REJECT_TERMS = [
  'unsubscribe',
  'abmelden',
  'preferences',
  'einstellungen',
  'privacy',
  'datenschutz',
  'terms',
  'agb',
  'impressum',
  'support',
  'help',
  'view in browser',
  'browseransicht',
];

const REJECT_HOSTS = [
  'facebook.com',
  'twitter.com',
  'x.com',
  'instagram.com',
  'linkedin.com',
  'youtube.com',
  'tiktok.com',
  'apps.apple.com',
  'play.google.com',
];

interface LinkCandidate {
  link: string;
  anchorText?: string;
  score: number;
  affiliated: boolean;
  tokenLength: number;
  order: number;
}

function hostMatches(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

/** Last two labels of the sender's mail domain ("mail.notion.so" → "notion.so"). */
function senderBaseDomain(senderAddress: string): string | undefined {
  const domain = senderAddress.split('@')[1]?.toLowerCase();
  if (!domain) return undefined;
  const labels = domain.split('.').filter(Boolean);
  if (labels.length < 2) return domain;
  return labels.slice(-2).join('.');
}

function longestOpaqueToken(url: URL): number {
  let longest = 0;
  const parts = [
    ...url.pathname.split('/'),
    ...[...url.searchParams.values()],
    url.hash.replace(/^#/, ''),
  ];
  for (const part of parts) {
    const m = part.match(OPAQUE_TOKEN_RE);
    if (m && m[0].length > longest) longest = m[0].length;
  }
  return longest;
}

function scoreUrl(
  href: string,
  anchorText: string | undefined,
  baseDomain: string | undefined,
  order: number,
): LinkCandidate | undefined {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;

  const host = url.hostname.toLowerCase();
  if (REJECT_HOSTS.some((h) => hostMatches(host, h))) return undefined;

  const rejectSurface = `${href} ${anchorText ?? ''}`.toLowerCase();
  if (REJECT_TERMS.some((t) => rejectSurface.includes(t))) return undefined;

  const pathAndQuery = `${url.pathname}${url.search}`.toLowerCase();
  let urlKeywordScore = 0;
  for (const re of URL_KEYWORDS) if (re.test(pathAndQuery)) urlKeywordScore += 2;
  urlKeywordScore = Math.min(urlKeywordScore, URL_KEYWORD_CAP);

  const tokenLength = longestOpaqueToken(url);
  const lowerAnchor = anchorText?.toLowerCase() ?? '';
  const anchorScore = ANCHOR_KEYWORDS.some((k) => lowerAnchor.includes(k)) ? 3 : 0;
  const affiliated = baseDomain !== undefined && hostMatches(host, baseDomain);

  const score = urlKeywordScore + (tokenLength >= 20 ? 2 : 0) + anchorScore + (affiliated ? 2 : 0);

  return { link: href, anchorText, score, affiliated, tokenLength, order };
}

function pickBest(candidates: LinkCandidate[]): LinkCandidate | undefined {
  return candidates
    .filter((c) => c.score >= ACCEPT_THRESHOLD)
    .sort(
      (a, b) =>
        b.score - a.score ||
        Number(b.affiliated) - Number(a.affiliated) ||
        b.tokenLength - a.tokenLength ||
        a.order - b.order,
    )[0];
}

/**
 * Extract the most likely sign-in/verification link. Returns `undefined`
 * when nothing clears the acceptance threshold.
 */
export function extractMagicLink(input: {
  bodyHtml?: string;
  bodyText?: string;
  senderAddress: string;
}): MagicLinkMatch | undefined {
  const baseDomain = senderBaseDomain(input.senderAddress);

  if (input.bodyHtml) {
    const candidates: LinkCandidate[] = [];
    let order = 0;
    ANCHOR_RE.lastIndex = 0;
    for (const m of input.bodyHtml.matchAll(ANCHOR_RE)) {
      const href = m[1] ?? m[2];
      if (!href) continue;
      const anchorText = stripHtml(m[3] ?? '').trim();
      const candidate = scoreUrl(href.trim(), anchorText, baseDomain, order);
      order += 1;
      if (candidate) candidates.push(candidate);
    }
    const best = pickBest(candidates);
    if (best) {
      return { link: best.link, anchorText: best.anchorText, score: best.score, source: 'html' };
    }
  }

  if (input.bodyText) {
    const candidates: LinkCandidate[] = [];
    let order = 0;
    BARE_URL_RE.lastIndex = 0;
    for (const m of input.bodyText.matchAll(BARE_URL_RE)) {
      const href = m[0].replace(TRAILING_PUNCT_RE, '');
      const candidate = scoreUrl(href, undefined, baseDomain, order);
      order += 1;
      if (candidate) candidates.push(candidate);
    }
    const best = pickBest(candidates);
    if (best) return { link: best.link, score: best.score, source: 'text' };
  }

  return undefined;
}
