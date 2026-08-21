/**
 * Reconciles the local mirror against the server.
 *
 * Three sync strategies, picked from what the server advertises:
 *
 * - **qresync**   modseq for changes, as condstore. The QRESYNC fast path
 *                 (VANISHED responses via `mailboxOpen(path, { qresync: true })`,
 *                 which would make the UID-set diff below unnecessary) is NOT
 *                 implemented — no server available here advertises QRESYNC,
 *                 and untested protocol code is worse than one extra SEARCH.
 * - **condstore** modseq gives changed messages cheaply, but says nothing
 *                 about deletions — Gmail is exactly this case, advertising
 *                 CONDSTORE and X-GM-EXT-1 but never QRESYNC. Expunges are
 *                 caught by a UID-set diff instead.
 * - **baseline**  no change tracking at all: fetch above the UID watermark
 *                 for new mail, and diff the UID set for deletions.
 *
 * All three are correct today; the tiers differ only in how much they
 * re-transfer. Detection is still recorded per mailbox so `cache status` can
 * report it and the QRESYNC path can be added later without a migration.
 *
 * The governing invariant is UIDVALIDITY. IMAP guarantees a UID is stable
 * only while a mailbox's UIDVALIDITY is unchanged; when it changes, every
 * cached UID silently refers to a different message. So it is checked on
 * every sync and a mismatch purges the generation before anything else runs.
 */

import type { ImapFlow } from 'imapflow';
import type { IConnectionManager } from '../connections/types.js';
import { mcpLog } from '../logging.js';
import type {
  ExpungeEvent,
  FlagsEvent,
  NewEmailEvent,
  ReconnectEvent,
} from '../services/event-bus.js';
import eventBus from '../services/event-bus.js';
import type CacheStore from './store.js';
import type { CachedMessageInput, SyncTier } from './store.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SyncResult {
  ok: boolean;
  account: string;
  mailbox: string;
  /** Messages inserted or updated. */
  stored: number;
  /** Messages removed because the server no longer lists them. */
  removed: number;
  /** True when the mailbox was purged and rebuilt from scratch. */
  epochReset: boolean;
  error?: string;
}

/** Minimal shape of an ImapFlow fetch response used here. */
interface FetchedMessage {
  uid: number;
  envelope?: {
    subject?: string;
    date?: Date;
    from?: { name?: string; address?: string }[];
    messageId?: string;
    inReplyTo?: string;
  };
  flags?: Set<string>;
  modseq?: bigint;
  bodyStructure?: unknown;
  internalDate?: Date;
}

/** Mailbox metadata exposed by ImapFlow after SELECT. */
interface MailboxInfo {
  uidValidity: bigint;
  uidNext?: number;
  highestModseq?: bigint;
  exists?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hasAttachment(bodyStructure: unknown): boolean {
  if (!bodyStructure || typeof bodyStructure !== 'object') return false;
  const bs = bodyStructure as Record<string, unknown>;
  if (bs.disposition === 'attachment') return true;
  if (Array.isArray(bs.childNodes)) {
    return bs.childNodes.some((child) => hasAttachment(child));
  }
  return false;
}

function formatSender(from?: { name?: string; address?: string }[]): string | undefined {
  const first = from?.[0];
  if (!first) return undefined;
  return first.name ? `${first.name} <${first.address ?? ''}>` : first.address;
}

function toCachedMessage(
  account: string,
  mailbox: string,
  uidValidity: string,
  msg: FetchedMessage,
): CachedMessageInput {
  const envelope = msg.envelope ?? {};
  const flags = [...(msg.flags ?? new Set<string>())];

  return {
    account,
    mailbox,
    uid: msg.uid,
    uidValidity,
    modseq: msg.modseq?.toString(),
    envelope,
    bodyStructure: msg.bodyStructure,
    flags,
    messageId: envelope.messageId,
    inReplyTo: envelope.inReplyTo,
    internalDate: (msg.internalDate ?? envelope.date ?? new Date()).getTime(),
    subject: envelope.subject,
    fromText: formatSender(envelope.from),
    hasAttachments: hasAttachment(msg.bodyStructure),
  };
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export default class SyncEngine {
  private tiers = new Map<string, SyncTier>();

  /** In-flight probes, so concurrent callers share one round trip. */
  private tierPending = new Map<string, Promise<SyncTier>>();

  /** Serializes syncs per mailbox so two runs cannot interleave. */
  private inFlight = new Map<string, Promise<SyncResult>>();

  private listening = false;

  private readonly onReconnect: (event: ReconnectEvent) => void;

  private readonly onNewEmail: (event: NewEmailEvent) => void;

  private readonly onExpunge: (event: ExpungeEvent) => void;

  private readonly onFlags: (event: FlagsEvent) => void;

  constructor(
    private connections: IConnectionManager,
    private store: CacheStore,
  ) {
    this.onReconnect = ({ account }) => {
      this.tiers.delete(account);
      this.tierPending.delete(account);
    };

    // The watcher reports mail arriving, disappearing and changing flags. Each
    // is a reason to reconcile, but never a reason to block a tool call, so
    // these are fire-and-forget.
    this.onNewEmail = ({ account, mailbox }) => {
      void this.syncMailbox(account, mailbox);
    };
    this.onExpunge = ({ account, mailbox }) => {
      void this.syncMailbox(account, mailbox);
    };
    this.onFlags = ({ account, mailbox }) => {
      void this.syncMailbox(account, mailbox);
    };
  }

  /** Subscribe to change notifications. */
  start(): void {
    if (this.listening) return;
    this.listening = true;
    eventBus.on('imap:reconnect', this.onReconnect);
    eventBus.on('email:new', this.onNewEmail);
    eventBus.on('email:expunge', this.onExpunge);
    eventBus.on('email:flags', this.onFlags);
  }

  stop(): void {
    if (!this.listening) return;
    this.listening = false;
    eventBus.off('imap:reconnect', this.onReconnect);
    eventBus.off('email:new', this.onNewEmail);
    eventBus.off('email:expunge', this.onExpunge);
    eventBus.off('email:flags', this.onFlags);
  }

  // -------------------------------------------------------------------------
  // Capability detection
  // -------------------------------------------------------------------------

  /**
   * Which sync strategy this account's server supports.
   *
   * Memoized per account with in-flight dedup — the same pattern
   * `ImapService.getLabelStrategy` uses — and dropped on `imap:reconnect`,
   * because capabilities belong to a connection, not to an account.
   */
  async detectTier(account: string): Promise<SyncTier> {
    const cached = this.tiers.get(account);
    if (cached) return cached;

    const pending = this.tierPending.get(account);
    if (pending) return pending;

    const probe = (async () => {
      try {
        const client = await this.connections.getImapClient(account);
        // ImapFlow types this as Map<string, boolean | number>, not a Set
        // (imap-flow.d.ts:761) — presence of the key is what matters.
        const caps: Map<string, boolean | number> | undefined = client.capabilities;

        let tier: SyncTier = 'baseline';
        if (caps?.has('QRESYNC')) tier = 'qresync';
        else if (caps?.has('CONDSTORE')) tier = 'condstore';

        this.tiers.set(account, tier);
        return tier;
      } finally {
        this.tierPending.delete(account);
      }
    })();

    this.tierPending.set(account, probe);
    return probe;
  }

  // -------------------------------------------------------------------------
  // Sync
  // -------------------------------------------------------------------------

  /**
   * Reconcile one mailbox.
   *
   * Never throws and never rethrows: a failed sync leaves the mirror exactly
   * as it was. A stale row can still answer a question, a deleted one cannot,
   * so a transient network error must not escalate into data loss.
   */
  async syncMailbox(account: string, mailbox: string): Promise<SyncResult> {
    const key = `${account} ${mailbox}`;
    const running = this.inFlight.get(key);
    if (running) return running;

    const run = this.runSync(account, mailbox).finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, run);
    return run;
  }

  private async runSync(account: string, mailbox: string): Promise<SyncResult> {
    const result: SyncResult = {
      ok: false,
      account,
      mailbox,
      stored: 0,
      removed: 0,
      epochReset: false,
    };

    try {
      const tier = await this.detectTier(account);
      const client = await this.connections.getImapClient(account);
      const lock = await client.getMailboxLock(mailbox);

      try {
        const info = (client as unknown as { mailbox?: MailboxInfo }).mailbox;
        if (!info?.uidValidity) {
          throw new Error(`Server did not report UIDVALIDITY for ${mailbox}`);
        }

        const uidValidity = info.uidValidity.toString();
        const previous = this.store.getMailboxState(account, mailbox);

        // The epoch check has to come first: on a mismatch every stored UID
        // now points at a different message, so nothing already cached can be
        // trusted or reused.
        if (previous && previous.uidValidity !== uidValidity) {
          const purged = this.store.resetEpoch(account, mailbox, uidValidity);
          result.epochReset = true;
          result.removed += purged;
          await mcpLog(
            'info',
            'cache',
            `UIDVALIDITY changed for ${account}/${mailbox} (${previous.uidValidity} → ${uidValidity}); purged ${purged} message(s)`,
          );
        }

        const baseline = result.epochReset ? undefined : previous;
        result.stored = await this.fetchChanges(
          client,
          account,
          mailbox,
          uidValidity,
          tier,
          baseline,
        );

        result.removed += await this.reconcileDeletions(client, account, mailbox, uidValidity);

        this.store.putMailboxState({
          account,
          mailbox,
          uidValidity,
          uidNext: info.uidNext,
          highestModseq: info.highestModseq?.toString(),
          syncTier: tier,
          totalMessages: info.exists,
          lastSyncedAt: Date.now(),
        });

        result.ok = true;
      } finally {
        lock.release();
      }
    } catch (err) {
      result.error = err instanceof Error ? err.message : String(err);
      await mcpLog('warning', 'cache', `Sync failed for ${account}/${mailbox}: ${result.error}`);
    }

    return result;
  }

  /**
   * Fetch whatever changed since the last sync and store it.
   *
   * @returns how many messages were written.
   */
  private async fetchChanges(
    client: ImapFlow,
    account: string,
    mailbox: string,
    uidValidity: string,
    tier: SyncTier,
    previous: { uidNext?: number; highestModseq?: string } | undefined,
  ): Promise<number> {
    const query = {
      uid: true,
      envelope: true,
      flags: true,
      bodyStructure: true,
      internalDate: true,
    };

    let range = '1:*';
    const options: { uid: boolean; changedSince?: bigint } = { uid: true };

    if (tier === 'condstore' || tier === 'qresync') {
      // Ask only for messages whose modseq moved. Covers flag changes made by
      // other clients, which a UID watermark alone would never notice.
      if (previous?.highestModseq) {
        options.changedSince = BigInt(previous.highestModseq);
      }
    } else if (previous?.uidNext) {
      // Baseline has no change tracking, so the best available signal is
      // "anything numbered at or above the last uidNext we saw".
      range = `${previous.uidNext}:*`;
    }

    const messages: CachedMessageInput[] = [];
    for await (const msg of client.fetch(range, query, options)) {
      const fetched = msg as unknown as FetchedMessage;
      if (typeof fetched.uid !== 'number') continue;
      messages.push(toCachedMessage(account, mailbox, uidValidity, fetched));
    }

    // An empty mailbox is a legitimate answer; so is "nothing changed".
    if (messages.length === 0) return 0;

    this.store.putMessages(messages);
    return messages.length;
  }

  /**
   * Drop messages the server no longer lists.
   *
   * Costs one SEARCH — cheap next to a fetch, and on a baseline-tier server it
   * is the *only* way a deletion is ever revealed: no modseq, no VANISHED, no
   * notification. CONDSTORE does not help here either, since modseq tracks
   * changes to existing messages and says nothing about removed ones.
   *
   * @returns how many messages were removed.
   */
  private async reconcileDeletions(
    client: ImapFlow,
    account: string,
    mailbox: string,
    uidValidity: string,
  ): Promise<number> {
    const serverUids = (await client.search({ all: true }, { uid: true })) as number[] | false;

    // A failed SEARCH returns false. Treating that as "the mailbox is empty"
    // would delete the entire mirror on a transient error.
    if (!Array.isArray(serverUids)) return 0;

    const live = new Set(serverUids);
    const cached = this.store.listAllUids(account, mailbox, uidValidity);
    const gone = cached.filter((uid) => !live.has(uid));

    if (gone.length === 0) return 0;

    this.store.deleteMessages(account, mailbox, gone, uidValidity);
    return gone.length;
  }
}
