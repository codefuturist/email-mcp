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

import { ImapFlow } from 'imapflow';
import buildImapAuth from '../connections/auth.js';
import { mcpLog } from '../logging.js';
import type { AccountConfig, EmailMeta, WatcherConfig } from '../types/index.js';
import eventBus from './event-bus.js';
import type OAuthService from './oauth.service.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface IdleState {
  client: ImapFlow | null;
  account: AccountConfig;
  folder: string;
  lastSeenUid: number;
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
// System flags excluded from label extraction
// ---------------------------------------------------------------------------

const SYSTEM_FLAGS = new Set([
  '\\Seen',
  '\\Answered',
  '\\Flagged',
  '\\Deleted',
  '\\Draft',
  '\\Recent',
  '\\*',
]);

// ---------------------------------------------------------------------------
// WatcherService
// ---------------------------------------------------------------------------

const MAX_BACKOFF_MS = 60_000;
const INITIAL_BACKOFF_MS = 1_000;

export default class WatcherService {
  private idleStates = new Map<string, IdleState>();

  private config: WatcherConfig;

  private accounts: AccountConfig[];

  private oauthService?: OAuthService;

  constructor(config: WatcherConfig, accounts: AccountConfig[], oauthService?: OAuthService) {
    this.config = config;
    this.accounts = accounts;
    this.oauthService = oauthService;
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
      const auth = await buildImapAuth(state.account, this.oauthService);

      const client = new ImapFlow({
        host: state.account.imap.host,
        port: state.account.imap.port,
        secure: state.account.imap.tls,
        tls: { rejectUnauthorized: state.account.imap.verifySsl },
        auth,
        logger: false,
        maxIdleTime: this.config.idleTimeout * 1000,
      });

      await client.connect();

      const lock = await client.getMailboxLock(state.folder);
      const { mailbox } = client;
      const uidNext =
        mailbox && typeof mailbox === 'object'
          ? ((mailbox as { uidNext?: number }).uidNext ?? 1)
          : 1;

      this.updateState(key, {
        client,
        lock,
        lastSeenUid: uidNext - 1,
        backoffMs: INITIAL_BACKOFF_MS,
      });

      // Listen for new messages
      client.on('exists', (data: { path: string; count: number; prevCount: number }) => {
        if (data.count > data.prevCount) {
          this.handleNewEmails(key).catch(() => {});
        }
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
      for await (const msg of state.client.fetch(searchRange, {
        uid: true,
        envelope: true,
        flags: true,
        bodyStructure: true,
      })) {
        if (msg.uid > state.lastSeenUid) {
          emails.push(WatcherService.buildEmailMeta(msg));
          maxUid = Math.max(maxUid, msg.uid);
        }
      }

      if (maxUid > state.lastSeenUid) {
        this.updateState(key, { lastSeenUid: maxUid });
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

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private static buildEmailMeta(msg: {
    uid: number;
    flags?: Set<string>;
    envelope?: {
      subject?: string;
      from?: { name?: string; address?: string }[];
      to?: { name?: string; address?: string }[];
      date?: Date;
    };
    bodyStructure?: unknown;
  }): EmailMeta {
    const flags = msg.flags ?? new Set<string>();
    const labels = [...flags].filter((f) => !SYSTEM_FLAGS.has(f));

    const from = msg.envelope?.from?.[0];
    const to = msg.envelope?.to ?? [];

    return {
      id: String(msg.uid),
      subject: msg.envelope?.subject ?? '(no subject)',
      from: { name: from?.name, address: from?.address ?? '' },
      to: to.map((a) => ({ name: a.name, address: a.address ?? '' })),
      date: msg.envelope?.date?.toISOString() ?? new Date().toISOString(),
      seen: flags.has('\\Seen'),
      flagged: flags.has('\\Flagged'),
      answered: flags.has('\\Answered'),
      hasAttachments: WatcherService.hasAttachments(msg.bodyStructure),
      labels,
    };
  }

  private static hasAttachments(bodyStructure: unknown): boolean {
    if (!bodyStructure || typeof bodyStructure !== 'object') return false;
    const bs = bodyStructure as { disposition?: string; childNodes?: unknown[] };
    if (bs.disposition === 'attachment') return true;
    return bs.childNodes?.some((child) => WatcherService.hasAttachments(child)) ?? false;
  }
}
