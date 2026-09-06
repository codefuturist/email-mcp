/**
 * Build IMAP/SMTP auth credentials for an account.
 *
 * Shared so every connection path derives credentials the same way. Duplicating
 * this is how the IDLE watcher came to pass `account.password` as an OAuth
 * bearer token — undefined for an OAuth2 account, since such an account has no
 * password to begin with.
 */

import type OAuthService from '../services/oauth.service.js';
import type { AccountConfig } from '../types/index.js';

export interface ImapAuth {
  user: string;
  pass?: string;
  accessToken?: string;
}

export default async function buildImapAuth(
  account: AccountConfig,
  oauthService?: OAuthService,
): Promise<ImapAuth> {
  if (!account.oauth2) {
    return { user: account.username, pass: account.password };
  }
  if (!oauthService) {
    throw new Error(
      `Account "${account.name}" is configured for OAuth2 but no OAuth service is available. ` +
        'This is a wiring error, not a configuration one.',
    );
  }
  return { user: account.username, accessToken: await oauthService.getAccessToken(account.oauth2) };
}
