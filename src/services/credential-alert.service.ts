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
 * One notification per account per failure episode: the watcher retries a
 * rejected password every 15 minutes, and being told once is help while
 * being told every 15 minutes is noise. A successful login ends the episode
 * (`clear`), so the next rotation notifies again.
 */

import { mcpLog } from '../logging.js';
import type { AccountConfig } from '../types/index.js';
import { authFailureHint, isAuthFailure } from '../utils/auth-error.js';
import type NotifierService from './notifier.service.js';

/** The slice of NotifierService this needs — the shared, rate-limited desktop path. */
type DesktopNotifier = Pick<NotifierService, 'notifyRaw' | 'getConfig'>;

export default class CredentialAlertService {
  /** Accounts already notified in their current failure episode. */
  private readonly notified = new Set<string>();

  private readonly notifier: DesktopNotifier;

  constructor(notifier: DesktopNotifier) {
    this.notifier = notifier;
  }

  /**
   * Notify about a credential rejection, unless this account's episode has
   * already been announced. Returns whether a notification went out. Errors
   * that are not credential rejections are ignored — a server being down is
   * not something the person can fix with a new password.
   */
  async report(account: AccountConfig, protocol: 'IMAP' | 'SMTP', err: unknown): Promise<boolean> {
    if (!isAuthFailure(err)) return false;
    if (this.notified.has(account.name)) return false;

    const server =
      protocol === 'IMAP'
        ? `${account.imap.host}:${account.imap.port}`
        : `${account.smtp.host}:${account.smtp.port}`;
    const title = `Email MCP — "${account.name}" needs a new password`;
    const body = [
      `${server} rejected the ${protocol} login for ${account.email}.`,
      authFailureHint(err, account) ?? '',
    ]
      .join(' ')
      .trim();

    try {
      await this.notifier.notifyRaw(title, body, { sound: this.notifier.getConfig().sound });
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

    this.notified.add(account.name);
    return true;
  }

  /** A successful login ends the account's failure episode. */
  clear(accountName: string): void {
    this.notified.delete(accountName);
  }
}
