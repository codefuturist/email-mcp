/**
 * Desktop notification when a server rejects an account's credentials.
 *
 * A stale password is the one failure that never fixes itself: the server
 * stays up, the network is fine, the watcher keeps retrying — and nothing
 * tells the person at the keyboard. Proton Bridge, for instance, mints a new
 * mailbox password every time its account is re-added, and the only sign in
 * email-mcp was a log line nobody reads. This turns that into a notification
 * that names the account and the exact command that fixes it.
 *
 * Cadence is the user's call ([settings.credential_alerts]): by default one
 * notification per account per failure episode — the watcher retries a
 * rejected password every 15 minutes, and being told once is help while
 * being told every 15 minutes is noise — or a reminder every N minutes while
 * still broken. A successful login ends the episode (`clear`), so the next
 * rotation notifies again. An account can opt out (or in) on its own.
 */

import { mcpLog } from '../logging.js';
import type { AccountConfig, CredentialAlertsConfig } from '../types/index.js';
import { authFailureHint, isAuthFailure } from '../utils/auth-error.js';
import type NotifierService from './notifier.service.js';

/** The slice of NotifierService this needs — the shared, rate-limited channels. */
type Notifier = Pick<NotifierService, 'notifyRaw' | 'postWebhook'>;

export default class CredentialAlertService {
  /** Accounts in a failure episode → when they were last notified (ms epoch). */
  private readonly lastNotified = new Map<string, number>();

  private readonly notifier: Notifier;

  private config: CredentialAlertsConfig;

  private readonly now: () => number;

  constructor(notifier: Notifier, config: CredentialAlertsConfig, now: () => number = Date.now) {
    this.notifier = notifier;
    this.config = { ...config };
    this.now = now;
  }

  getConfig(): CredentialAlertsConfig {
    return { ...this.config };
  }

  /** Runtime update (configure_alerts tool, config reload); returns the merged config. */
  updateConfig(partial: Partial<CredentialAlertsConfig>): CredentialAlertsConfig {
    this.config = { ...this.config, ...partial };
    return this.getConfig();
  }

  /**
   * Notify about a credential rejection, unless this account's episode has
   * already been announced (and no reminder is due). Returns whether a
   * notification went out. Errors that are not credential rejections are
   * ignored — a server being down is not fixed with a new password.
   */
  async report(account: AccountConfig, protocol: 'IMAP' | 'SMTP', err: unknown): Promise<boolean> {
    if (!isAuthFailure(err)) return false;
    if (!(account.credentialAlerts ?? this.config.enabled)) return false;

    const last = this.lastNotified.get(account.name);
    if (last !== undefined) {
      const remindMs = this.config.remindEveryMinutes * 60_000;
      if (remindMs === 0 || this.now() - last < remindMs) return false;
    }

    const server =
      protocol === 'IMAP'
        ? `${account.imap.host}:${account.imap.port}`
        : `${account.smtp.host}:${account.smtp.port}`;
    const fix = authFailureHint(err, account) ?? '';
    const title = `Email MCP — "${account.name}" needs a new password`;
    const body = `${server} rejected the ${protocol} login for ${account.email}. ${fix}`.trim();

    try {
      await this.notifier.notifyRaw(title, body, { sound: this.config.sound });
    } catch (notifyErr) {
      // Stay armed: the next retry gets another chance to reach the desktop.
      const detail = notifyErr instanceof Error ? notifyErr.message : String(notifyErr);
      await mcpLog(
        'warning',
        'credential-alert',
        `Desktop notification for "${account.name}" failed: ${detail}`,
      );
      return false;
    }

    if (this.config.webhook) {
      // Best-effort, like every other webhook post; the desktop one counted.
      this.notifier
        .postWebhook('credential.rejected', {
          account: account.name,
          email: account.email,
          protocol,
          server,
          fix,
        })
        .catch(() => {});
    }

    this.lastNotified.set(account.name, this.now());
    return true;
  }

  /** A successful login ends the account's failure episode. */
  clear(accountName: string): void {
    this.lastNotified.delete(accountName);
  }
}
