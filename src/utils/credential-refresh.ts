/**
 * Re-read an account's secret from where it came from.
 *
 * `loadConfig` resolves `keychain:`/`env:` references once and keeps the
 * reference on the account as `passwordRef`. A long-running server would
 * otherwise hold the first value forever, so a rotated password meant
 * restarting every server that had the old one — and with several MCP
 * clients each running their own email-mcp, that is never just one.
 *
 * The account object is updated IN PLACE on purpose: the watcher and the
 * connection manager share it, so both pick up the rotated secret.
 */

import { resolveSecret } from '../config/secret-resolver.js';
import type { AccountConfig } from '../types/index.js';

/** Re-resolve `passwordRef` into `password`; true when the value changed. */
export async function refreshAccountSecret(account: AccountConfig): Promise<boolean> {
  if (!account.passwordRef) return false;
  const fresh = await resolveSecret(account.passwordRef);
  if (fresh === account.password) return false;
  account.password = fresh;
  return true;
}
