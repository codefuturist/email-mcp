/**
 * Turning rejected credentials into the one thing that fixes them.
 *
 * Both protocols report a bad password in their own dialect — imapflow
 * surfaces `AUTHENTICATIONFAILED`, nodemailer an `EAUTH` wrapping
 * `535-5.7.8 Username and Password not accepted`. Neither says what the user
 * must actually do, which for Gmail, Yahoo and iCloud is "a normal password
 * cannot work here, mint an app password". That guidance already exists
 * per-provider in the provider table; this maps a failure onto it.
 */

import { findProviderForAccount } from '../config/providers.js';
import type { AccountConfig } from '../types/index.js';

/** Error codes either protocol uses for "credentials rejected". */
const AUTH_CODES = new Set(['EAUTH', 'AUTHENTICATIONFAILED']);

/** SMTP replies for bad credentials: 534/535 auth failed, 538 encryption required. */
const AUTH_REPLY_CODES = new Set([534, 535, 538]);

const AUTH_TEXT =
  /authenticationfailed|authentication failed|invalid login|invalid credentials|username and password not accepted|login failed|password.*(incorrect|rejected)/i;

/**
 * Does this error mean the credentials were rejected, as opposed to the
 * server being unreachable? Only the former is worth a credential hint —
 * attaching one to a DNS failure would send the user down the wrong path.
 */
export function isAuthFailure(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as {
    code?: unknown;
    responseCode?: unknown;
    authenticationFailed?: unknown;
    message?: unknown;
    response?: unknown;
  };

  if (e.authenticationFailed === true) return true;
  if (typeof e.code === 'string' && AUTH_CODES.has(e.code.toUpperCase())) return true;
  if (typeof e.responseCode === 'number' && AUTH_REPLY_CODES.has(e.responseCode)) return true;

  const text = [e.message, e.response].filter((v) => typeof v === 'string').join(' ');
  return text.length > 0 && AUTH_TEXT.test(text);
}

/** What the user should do about it, given who hosts the mailbox. */
function remedy(account: AccountConfig): string {
  if (account.oauth2) {
    return (
      'The OAuth2 refresh token looks expired or revoked — re-authorize and update ' +
      `[accounts.${account.name}.oauth2] in your config.`
    );
  }

  const provider = findProviderForAccount(account);
  if (provider?.notes) {
    return `${provider.name}: ${provider.notes}`;
  }
  if (provider?.oauth2) {
    return `${provider.name} may require OAuth2 rather than a password.`;
  }
  return 'Check the username and password — many providers require an app password rather than your account password.';
}

/**
 * The remedy alone, for callers that already show the server's message and
 * the host — a CLI spinner line, say — and need the guidance beside it
 * rather than a prose block repeating what is on screen. Undefined when the
 * failure was not about credentials.
 */
export function authFailureHint(err: unknown, account: AccountConfig): string | undefined {
  if (!isAuthFailure(err)) return undefined;
  return `${remedy(account)} ${updateCommands(account)}`;
}

/**
 * Both ways to replace the credential: piped (for agents, scripts, and a
 * `pbpaste |` one-liner — nothing echoed, nothing in argv) and the
 * interactive editor. Health output is read by agents at least as often as
 * by a human at a TTY, so the non-TTY remedy comes first.
 */
function updateCommands(account: AccountConfig): string {
  return (
    `Update it with: email-mcp account set-secret ${account.name} --stdin (piped), ` +
    `or interactively: email-mcp account edit ${account.name}`
  );
}

/**
 * Rephrase a rejected-credentials error as something actionable, keeping the
 * server's own words so a provider-specific reason is not lost.
 *
 * @param err the original failure
 * @param account whose credentials were refused
 * @param protocol which leg failed, so the user knows which host to fix
 */
export function describeAuthFailure(
  err: unknown,
  account: AccountConfig,
  protocol: 'IMAP' | 'SMTP',
): string {
  const server =
    protocol === 'IMAP'
      ? `${account.imap.host}:${account.imap.port}`
      : `${account.smtp.host}:${account.smtp.port}`;
  const detail = err instanceof Error ? err.message : String(err);

  return [
    `${protocol} authentication failed for account "${account.name}" at ${server}.`,
    remedy(account),
    `Server said: ${detail}`,
    updateCommands(account),
  ].join('\n');
}

/**
 * Run a connect/login step, replacing a credentials rejection with guidance.
 * Anything else — timeouts, TLS failures, DNS — passes through untouched.
 */
export async function withAuthGuidance<T>(
  account: AccountConfig,
  protocol: 'IMAP' | 'SMTP',
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (!isAuthFailure(err)) throw err;
    throw new Error(describeAuthFailure(err, account, protocol), { cause: err });
  }
}
