/**
 * IMAP IDLE Watcher — real-time email monitoring.
 *
 * Maintains dedicated IMAP connections per account using IDLE to detect
 * new emails in real-time. Emits events on the shared event bus.
 *
 * Key design decisions:
 * - Separate ImapFlow connections from ConnectionManager (IDLE holds lock)
 * - Auto-reconnect with exponential backoff on connection failures
 * - Tracks last-seen UID per folder to detect genuinely new messages
 */

import type { ImapFlow } from 'imapflow';
import { mcpLog } from '../logging.js';
import type { AccountConfig, EmailMeta, WatcherConfig } from '../types/index.js';
import { describeAuthFailure, isAuthFailure } from '../utils/auth-error.js';
import { createImapClient } from '../utils/imap-client.js';
import { readWatermark, resolveBaselineUid, writeWatermark } from '../utils/watcher-state.js';
import type CredentialAlertService from './credential-alert.service.js';
import eventBus from './event-bus.js';
import { messageToEmailMeta } from './imap.service.js';
import type OAuthService from './oauth.service.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface IdleState {
  client: ImapFlow | null;
  account: AccountConfig;
  folder: string;
  lastSeenUid: number;
  /** UIDVALIDITY the watermark above belongs to; '' until first connect. */
  uidValidity: string;
  lock: { release: () => void } | null;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  backoffMs: number;
  stopped: boolean;
}

export interface WatcherStatus {
  account: string;
  folder: string;
  connected: boolean;
  lastSeenUid: number;
}

// ---------------------------------------------------------------------------
// WatcherService
// ---------------------------------------------------------------------------

const MAX_BACKOFF_MS = 60_000;
const INITIAL_BACKOFF_MS = 1_000;
/**
 * A rejected credential cannot fix itself while this process runs — the
 * config was read once at startup — and retrying it on the connection-failure
 * cadence trips server-side login jails (Proton Bridge: "too many login
 * attempts"), which then masks the real cause. Retry rarely, log loudly.
 */
const AUTH_FAILURE_BACKOFF_MS = 15 * 60_000;

export default class WatcherService {
  private idleStates = new Map<string, IdleState>();

  private config: WatcherConfig;

  private accounts: AccountConfig[];

  private oauthService?: OAuthService;

  /** Desktop notification on a rejected credential; absent in tests and the CLI. */
  private credentialAlerts?: CredentialAlertService;

  constructor(
    config: WatcherConfig,
    accounts: AccountConfig[],
    oauthService?: OAuthService,
    credentialAlerts?: CredentialAlertService,
  ) {
    this.config = config;
    this.accounts = accounts;
    this.oauthService = oauthService;
    this.credentialAlerts = credentialAlerts;
  }

  /**
   * IMAP credentials for an account, exchanging the refresh token for an
   * access token when the account uses OAuth2.
   *
   * The watcher builds its own connections rather than borrowing the pooled
   * ones, because IDLE holds the mailbox lock — so it also has to do its own
   * auth. It previously passed `account.password` as the access token, which
   * is undefined for an OAuth account, so IDLE could never authenticate and
   * the verification catcher and hooks were silently dead for exactly the
   * users Google and Microsoft are moving onto OAuth.
   */
  private static async buildAuth(
    account: AccountConfig,
    oauthService?: OAuthService,
  ): Promise<{ user: string; pass?: string; accessToken?: string }> {
    if (!account.oauth2) {
      return { user: account.username, pass: account.password };
    }
    if (!oauthService) {
      throw new Error(
        `Account "${account.name}" uses OAuth2 but the watcher was built without an OAuth service`,
      );
    }
    return {
      user: account.username,
      accessToken: await oauthService.getAccessToken(account.oauth2),
    };
  }

  async start(): Promise<void> {
    if (!this.config.enabled) return;

    const { folders } = this.config;
    const startOps: Promise<void>[] = [];
    this.accounts.forEach((account) => {
      folders.forEach((folder) => {
        startOps.push(this.startIdle(account, folder));
      });
    });
    await Promise.allSettled(startOps);
  }

  async stop(): Promise<void> {
    const stopOps = [...this.idleStates.values()].map(async (state) => {
      this.updateState(WatcherService.stateKey(state), { stopped: true });
      if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
      try {
        state.lock?.release();
        if (state.client) await state.client.logout();
      } catch {
        /* ignore */
      }
    });
    await Promise.allSettled(stopOps);
    this.idleStates.clear();
  }

  getStatus(): WatcherStatus[] {
    return [...this.idleStates.values()].map((state) => ({
      account: state.account.name,
      folder: state.folder,
      connected: state.client?.usable === true,
      lastSeenUid: state.lastSeenUid,
    }));
  }

  // -------------------------------------------------------------------------
  // State helpers (avoid param reassignment)
  // -------------------------------------------------------------------------

  private static stateKey(state: IdleState): string {
    return `${state.account.name}:${state.folder}`;
  }

  private updateState(key: string, updates: Partial<IdleState>): void {
    const state = this.idleStates.get(key);
    if (state) Object.assign(state, updates);
  }

  // -------------------------------------------------------------------------
  // IDLE connection lifecycle
  // -------------------------------------------------------------------------

  private async startIdle(account: AccountConfig, folder: string): Promise<void> {
    const key = `${account.name}:${folder}`;
    this.idleStates.set(key, {
      client: null,
      account,
      folder,
      lastSeenUid: 0,
      uidValidity: '',
      lock: null,
      reconnectTimer: null,
      backoffMs: INITIAL_BACKOFF_MS,
      stopped: false,
    });
    await this.connectIdle(key);
  }

  private async connectIdle(key: string): Promise<void> {
    const state = this.idleStates.get(key);
    if (!state || state.stopped) return;

    try {
      // Resolved per connect, not once at startup: OAuth access tokens are
      // short-lived relative to an IDLE hold (up to 29 minutes), so a
      // reconnect after expiry needs a fresh one. OAuthService refreshes
      // behind a 5-minute buffer and caches on the shared account config, so
      // this costs nothing while the token is still good.
      const auth = await WatcherService.buildAuth(state.account, this.oauthService);

      const client = createImapClient({
        host: state.account.imap.host,
        port: state.account.imap.port,
        secure: state.account.imap.tls,
        tls: { rejectUnauthorized: state.account.imap.verifySsl },
        auth,
        logger: false,
        maxIdleTime: this.config.idleTimeout * 1000,
      });

      await client.connect();
      // Accepted credentials end any failure episode this account was in.
      this.credentialAlerts?.clear(state.account.name);

      const lock = await client.getMailboxLock(state.folder);
      const { mailbox } = client;
      const box =
        mailbox && typeof mailbox === 'object'
          ? (mailbox as { uidNext?: number; uidValidity?: bigint | number })
          : {};
      const uidNext = box.uidNext ?? 1;
      const uidValidity = box.uidValidity?.toString() ?? '';

      // Resuming, not re-baselining: UIDNEXT-1 would silently skip everything
      // that arrived while this process was down or mid-reconnect.
      const stored = await readWatermark(state.account.name, state.folder);
      const lastSeenUid = resolveBaselineUid({
        inMemoryLastSeenUid: state.lastSeenUid,
        stored,
        uidValidity,
        uidNext,
      });

      this.updateState(key, {
        client,
        lock,
        lastSeenUid,
        uidValidity,
        backoffMs: INITIAL_BACKOFF_MS,
      });

      // Listen for new messages
      client.on('exists', (data: { path: string; count: number; prevCount: number }) => {
        if (data.count > data.prevCount) {
          this.handleNewEmails(key).catch(() => {});
        }
      });

      // Messages removed — by us or by another client. Republished so caches
      // and subscribers can drop the message rather than serving a deleted one.
      client.on('expunge', (data) => {
        eventBus.emit('email:expunge', {
          account: state.account.name,
          mailbox: state.folder,
          uid: data.uid,
          seq: data.seq,
        });
      });

      // Flag changes are the most common out-of-band mutation: marking a
      // message read in a phone client must not leave this process convinced
      // it is still unread.
      client.on('flags', (data) => {
        eventBus.emit('email:flags', {
          account: state.account.name,
          mailbox: state.folder,
          uid: data.uid,
          seq: data.seq,
          flags: [...data.flags],
        });
      });

      // Auto-reconnect on close
      client.on('close', () => {
        this.updateState(key, { lock: null, client: null });
        const current = this.idleStates.get(key);
        if (current && !current.stopped) {
          this.scheduleReconnect(key);
        }
      });

      client.on('error', () => {
        // Error will be followed by 'close' event
      });

      await mcpLog(
        'info',
        'watcher',
        `IDLE started: ${state.account.name}/${state.folder} (uid > ${uidNext - 1})`,
      );
    } catch (err) {
      if (isAuthFailure(err)) {
        await mcpLog(
          'error',
          'watcher',
          `IDLE for ${state.account.name}/${state.folder} is parked until the credential is ` +
            `fixed (next attempt in ${AUTH_FAILURE_BACKOFF_MS / 60_000} min).\n` +
            describeAuthFailure(err, state.account, 'IMAP'),
        );
        await this.credentialAlerts?.report(state.account, 'IMAP', err);
        this.updateState(key, { backoffMs: AUTH_FAILURE_BACKOFF_MS });
        this.scheduleReconnect(key);
        return;
      }
      const errMsg = err instanceof Error ? err.message : String(err);
      await mcpLog(
        'warning',
        'watcher',
        `IDLE connect failed for ${state.account.name}/${state.folder}: ${errMsg}`,
      );
      this.scheduleReconnect(key);
    }
  }

  private scheduleReconnect(key: string): void {
    const state = this.idleStates.get(key);
    if (!state || state.stopped) return;

    const { backoffMs } = state;
    mcpLog(
      'info',
      'watcher',
      `Reconnecting ${state.account.name}/${state.folder} in ${backoffMs}ms`,
    ).catch(() => {});

    const timer = setTimeout(() => {
      this.updateState(key, { backoffMs: Math.min(backoffMs * 2, MAX_BACKOFF_MS) });
      this.connectIdle(key).catch(() => {});
    }, backoffMs);

    this.updateState(key, { reconnectTimer: timer });
  }

  // -------------------------------------------------------------------------
  // New email detection
  // -------------------------------------------------------------------------

  private async handleNewEmails(key: string): Promise<void> {
    const state = this.idleStates.get(key);
    if (!state?.client) return;

    try {
      const searchRange = `${state.lastSeenUid + 1}:*`;
      const emails: EmailMeta[] = [];
      let maxUid = state.lastSeenUid;

      // eslint-disable-next-line no-restricted-syntax -- need sequential async iteration
      for await (const msg of state.client.fetch(
        searchRange,
        {
          uid: true,
          envelope: true,
          flags: true,
          bodyStructure: true,
        },
        // Third arg is what makes `searchRange` a UID range. The `uid` in the
        // query above only asks for the UID to be included in the response.
        { uid: true },
      )) {
        if (msg.uid > state.lastSeenUid) {
          emails.push(messageToEmailMeta(msg as unknown as Record<string, unknown>));
          maxUid = Math.max(maxUid, msg.uid);
        }
      }

      if (maxUid > state.lastSeenUid) {
        this.updateState(key, { lastSeenUid: maxUid });
        // Persisted so the next process resumes here instead of re-baselining.
        // Awaited rather than fired-and-forgotten: this subsystem is
        // concurrency-sensitive and a dropped rejection here would be silent.
        await writeWatermark(state.account.name, state.folder, state.uidValidity, maxUid).catch(
          (err: unknown) => {
            mcpLog('warning', 'watcher', `could not persist watermark: ${String(err)}`);
          },
        );
      }

      if (emails.length > 0) {
        eventBus.emit('email:new', {
          account: state.account.name,
          mailbox: state.folder,
          emails,
        });

        await mcpLog(
          'info',
          'watcher',
          `📬 ${emails.length} new email(s) in ${state.account.name}/${state.folder}`,
        );
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await mcpLog('warning', 'watcher', `Failed to fetch new emails: ${errMsg}`);
    }
  }
}
