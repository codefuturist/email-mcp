/**
 * Connection manager for lazy-persistent IMAP and SMTP connections.
 *
 * - Creates connections on first use per account
 * - Reuses open connections across tool calls
 * - Auto-reconnects on failure
 * - Graceful shutdown closes all connections
 */

import type { ImapFlow } from 'imapflow';
import type { TransportConfig, Transporter } from 'nodemailer';
import nodemailer from 'nodemailer';
import { mcpLog } from '../logging.js';

import eventBus from '../services/event-bus.js';
import type OAuthService from '../services/oauth.service.js';
import type { AccountConfig } from '../types/index.js';
import { authFailureHint, withAuthGuidance } from '../utils/auth-error.js';
import { createImapClient } from '../utils/imap-client.js';
import type { IConnectionManager } from './types.js';

type SmtpAuth =
  | { user: string; pass?: string }
  | { type: string; user: string; accessToken: string };

/**
 * A `starttls = true` account demands an encrypted session on a plain port.
 * imapflow upgrades opportunistically when the server offers STARTTLS, but it
 * will also happily stay plaintext when the server does not — so the flag was
 * silently unenforced (proven E2E against a no-STARTTLS server 2026-10-10).
 * nodemailer's requireTLS covers SMTP; this is the IMAP counterpart.
 */
async function assertImapUpgraded(client: ImapFlow, account: AccountConfig): Promise<void> {
  if (!account.imap.starttls || account.imap.tls) return;
  const secured = (client as unknown as { secureConnection?: boolean }).secureConnection;
  if (secured) return;
  try {
    await client.logout();
  } catch {
    client.close();
  }
  throw new Error(
    `IMAP connection to ${account.imap.host}:${account.imap.port} stayed plaintext but ` +
      `starttls = true requires an upgraded session — the server likely does not support STARTTLS.`,
  );
}

export default class ConnectionManager implements IConnectionManager {
  private imapClients = new Map<string, ImapFlow>();
  private imapPending = new Map<string, Promise<ImapFlow>>();
  private closing = false;

  private smtpTransports = new Map<string, Transporter>();

  private accounts = new Map<string, AccountConfig>();

  private oauthService?: OAuthService;

  constructor(accounts: AccountConfig[], oauthService?: OAuthService) {
    accounts.forEach((account) => {
      this.accounts.set(account.name, account);
    });
    this.oauthService = oauthService;
  }

  // -------------------------------------------------------------------------
  // Account lookup
  // -------------------------------------------------------------------------

  getAccount(name: string): AccountConfig {
    const account = this.accounts.get(name);
    if (!account) {
      throw new Error(
        `Account "${name}" not found. Available: ${[...this.accounts.keys()].join(', ')}`,
      );
    }
    return account;
  }

  getAccountNames(): string[] {
    return [...this.accounts.keys()];
  }

  // -------------------------------------------------------------------------
  // IMAP
  // -------------------------------------------------------------------------

  /**
   * ImapFlow is an EventEmitter; Node's default behaviour for an unhandled
   * 'error' is to throw, which on a cached, long-lived connection crashes the
   * whole process — an idle socket timeout or the server hanging up become
   * uncatchable. 'close' needs the same handling: a client that closes
   * cleanly is just as dead as one that errored, and the next caller must not
   * be handed the same stale object.
   *
   * `invalidateIfCurrent` guards the one race this introduces: an old
   * client's socket can keep tearing down after `getImapClient` has already
   * replaced it in the map, so a trailing event from the old object must not
   * evict the new one that took its place.
   */
  private registerImapLifecycle(accountName: string, client: ImapFlow): void {
    const invalidateIfCurrent = (): void => {
      if (this.imapClients.get(accountName) === client) {
        this.imapClients.delete(accountName);
        // Same signal the usable===false path sends: anything derived from
        // this connection — capability probes, cached UIDVALIDITY,
        // label-strategy memos — is now suspect.
        eventBus.emit('imap:reconnect', { account: accountName });
      }
    };

    client.on('error', (err: Error) => {
      invalidateIfCurrent();
      mcpLog('warning', 'imap', `IMAP connection lost for "${accountName}": ${err.message}`).catch(
        () => undefined,
      );
    });
    client.on('close', invalidateIfCurrent);
  }

  async getImapClient(accountName: string): Promise<ImapFlow> {
    if (this.closing) throw new Error('Connection manager is closing');
    const pending = this.imapPending.get(accountName);
    if (pending) return pending;
    const operation = this.connectImap(accountName);
    this.imapPending.set(accountName, operation);
    try {
      return await operation;
    } finally {
      this.imapPending.delete(accountName);
    }
  }

  private async connectImap(accountName: string): Promise<ImapFlow> {
    const existing = this.imapClients.get(accountName);
    if (existing?.usable) {
      return existing;
    }

    // Clean up stale connection
    if (existing) {
      this.imapClients.delete(accountName);
      try {
        existing.close();
      } catch {
        /* ignore */
      }
      // Announce the replacement. A new connection may be talking to a
      // different server, or to a mailbox that has been recreated since —
      // so capability probes, per-account memos and any cached UIDVALIDITY
      // derived from the old connection must be revalidated.
      eventBus.emit('imap:reconnect', { account: accountName });
    }

    const account = this.getAccount(accountName);

    // Build auth config based on auth type
    let auth: { user: string; pass?: string; accessToken?: string };
    if (account.oauth2 && this.oauthService) {
      const accessToken = await this.oauthService.getAccessToken(account.oauth2);
      auth = { user: account.username, accessToken };
    } else {
      auth = { user: account.username, pass: account.password };
    }

    const client = createImapClient({
      host: account.imap.host,
      port: account.imap.port,
      secure: account.imap.tls,
      tls: {
        rejectUnauthorized: account.imap.verifySsl,
      },
      auth,
      logger: false,
    });

    this.registerImapLifecycle(accountName, client);
    try {
      await withAuthGuidance(account, 'IMAP', () => client.connect());
      await assertImapUpgraded(client, account);
      if (this.closing) throw new Error('Connection manager is closing');
    } catch (err) {
      try {
        client.close();
      } catch {
        // Preserve the connection/authentication error.
      }
      throw err;
    }
    await mcpLog(
      'info',
      'imap',
      `Connected to ${account.imap.host}:${account.imap.port} for "${accountName}"`,
    );
    this.imapClients.set(accountName, client);
    return client;
  }

  // -------------------------------------------------------------------------
  // SMTP
  // -------------------------------------------------------------------------

  private static buildSmtpTransportOptions(
    account: AccountConfig,
    auth: SmtpAuth,
  ): TransportConfig {
    const pool = account.smtp.pool ?? {
      enabled: true,
      maxConnections: 1,
      maxMessages: 100,
    };

    return {
      host: account.smtp.host,
      port: account.smtp.port,
      secure: account.smtp.tls,
      requireTLS: account.smtp.starttls,
      ignoreTLS: !account.smtp.tls && !account.smtp.starttls,
      tls: {
        rejectUnauthorized: account.smtp.verifySsl,
      },
      auth,
      pool: pool.enabled,
      ...(pool.enabled
        ? {
            maxConnections: pool.maxConnections,
            maxMessages: pool.maxMessages,
          }
        : {}),
    } as TransportConfig;
  }

  async getSmtpTransport(
    accountName: string,
    options?: { verify?: boolean },
  ): Promise<Transporter> {
    const verify = options?.verify ?? false;
    const existing = this.smtpTransports.get(accountName);
    if (existing) {
      if (!verify) {
        return existing;
      }
      try {
        await existing.verify();
        return existing;
      } catch {
        this.smtpTransports.delete(accountName);
        try {
          existing.close();
        } catch {
          /* ignore */
        }
      }
    }

    const account = this.getAccount(accountName);

    // Build auth config based on auth type
    let auth: SmtpAuth;
    if (account.oauth2 && this.oauthService) {
      const accessToken = await this.oauthService.getAccessToken(account.oauth2);
      auth = { type: 'OAuth2', user: account.username, accessToken };
    } else {
      auth = { user: account.username, pass: account.password };
    }

    const transport = nodemailer.createTransport(
      ConnectionManager.buildSmtpTransportOptions(account, auth),
    );

    await withAuthGuidance(account, 'SMTP', () => transport.verify());
    await mcpLog(
      'info',
      'smtp',
      `Connected to ${account.smtp.host}:${account.smtp.port} for "${accountName}"`,
    );
    this.smtpTransports.set(accountName, transport);
    return transport;
  }

  async verifySmtpTransport(accountName: string): Promise<void> {
    await this.getSmtpTransport(accountName, { verify: true });
  }

  // -------------------------------------------------------------------------
  // Test connections (for setup wizard / test command)
  // -------------------------------------------------------------------------

  static async testImap(
    account: AccountConfig,
    oauthService?: OAuthService,
  ): Promise<{
    success: boolean;
    error?: string;
    /** What to do about a rejected credential, for the caller to render. */
    hint?: string;
    details?: { messages: number; folders: number };
  }> {
    let client: ImapFlow | undefined;
    try {
      let auth: { user: string; pass?: string; accessToken?: string };
      if (account.oauth2 && oauthService) {
        const accessToken = await oauthService.getAccessToken(account.oauth2);
        auth = { user: account.username, accessToken };
      } else {
        auth = { user: account.username, pass: account.password };
      }

      client = createImapClient({
        host: account.imap.host,
        port: account.imap.port,
        secure: account.imap.tls,
        tls: {
          rejectUnauthorized: account.imap.verifySsl,
        },
        auth,
        logger: false,
      });
      // This connection is short-lived (closed in the `finally` below), but
      // it is still an EventEmitter: a stray socket error between awaits
      // would otherwise crash the process running `email-mcp test` instead
      // of being reported as the probe failure it is.
      client.on('error', () => undefined);
      await client.connect();
      await assertImapUpgraded(client, account);

      const mailboxes = await client.list();
      let messageCount = 0;
      try {
        const inbox = await client.status('INBOX', {
          messages: true,
          unseen: true,
        });
        messageCount = inbox ? (inbox.messages ?? 0) : 0;
      } catch {
        // INBOX may not exist (e.g. Google Workspace uses "All Mail")
        const firstMailbox = mailboxes[0];
        if (firstMailbox) {
          try {
            const first = await client.status(firstMailbox.path, {
              messages: true,
            });
            messageCount = first ? (first.messages ?? 0) : 0;
          } catch {
            /* ignore — connection still works */
          }
        }
      }

      return {
        success: true,
        details: {
          messages: messageCount,
          folders: mailboxes.length,
        },
      };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        hint: authFailureHint(err, account),
      };
    } finally {
      if (client) {
        try {
          await client.logout();
        } catch {
          /* ignore */
        }
      }
    }
  }

  static async testSmtp(
    account: AccountConfig,
    oauthService?: OAuthService,
  ): Promise<{ success: boolean; error?: string; hint?: string }> {
    let transport: Transporter | undefined;
    try {
      let auth: SmtpAuth;
      if (account.oauth2 && oauthService) {
        const accessToken = await oauthService.getAccessToken(account.oauth2);
        auth = { type: 'OAuth2', user: account.username, accessToken };
      } else {
        auth = { user: account.username, pass: account.password };
      }

      transport = nodemailer.createTransport(
        ConnectionManager.buildSmtpTransportOptions(account, auth),
      );
      await transport.verify();
      return { success: true };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        hint: authFailureHint(err, account),
      };
    } finally {
      transport?.close();
    }
  }

  // -------------------------------------------------------------------------
  // Shutdown
  // -------------------------------------------------------------------------

  async closeAll(): Promise<void> {
    this.closing = true;
    await Promise.allSettled(this.imapPending.values());
    await mcpLog('info', 'connections', 'Closing all connections');
    const closeOps: Promise<void>[] = [];

    Array.from(this.imapClients.entries()).forEach(([name, client]) => {
      closeOps.push(
        client
          .logout()
          .catch(() => {})
          .then(() => {
            this.imapClients.delete(name);
          }),
      );
    });

    Array.from(this.smtpTransports.entries()).forEach(([name, transport]) => {
      transport.close();
      this.smtpTransports.delete(name);
    });

    await Promise.allSettled(closeOps);
  }
}
