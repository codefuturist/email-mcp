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
  MailboxChangedEvent,
  NewEmailEvent,
  ReconnectEvent,
} from '../services/event-bus.js';
import eventBus from '../services/event-bus.js';
import { collectTextParts, parseHeaders, selectBodyParts } from '../services/mime-structure.js';
import { unflowFormatFlowed } from '../utils/body-format.js';
import { stripHtml } from '../utils/html.js';
import type CacheStore from './store.js';
import type { CachedMessageInput, SyncTier } from './store.js';
import { MAX_CACHED_BODY_BYTES } from './store.js';

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
  /** Raw header subset when the fetch asked for specific headers. */
  headers?: Buffer;
  /** RFC 8474 EMAILID / Gmail X-GM-MSGID when the server supports it. */
  emailId?: string;
}

/** Options controlling how much of a mailbox the mirror takes on. */
export interface SyncEngineOptions {
  /**
   * On the first sync of a mailbox, only messages newer than this many days
   * are mirrored (0 = everything). Later syncs are incremental from the
   * watermark, so the window only bounds the initial transfer.
   */
  windowDays?: number;
  /**
   * How many message bodies the backfill keeps per mailbox (0 = no body
   * backfill). Bodies fetched on demand by get_email are stored regardless.
   */
  bodyMessages?: number;
  /**
   * The cache byte budget, so prefetching stops before it starts competing
   * with the eviction pass.
   */
  maxSizeMb?: number;
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

/** Collect attachment filenames from a body structure, for FTS indexing. */
function attachmentNames(bodyStructure: unknown): string[] {
  if (!bodyStructure || typeof bodyStructure !== 'object') return [];
  const bs = bodyStructure as Record<string, unknown>;
  const names: string[] = [];
  if (bs.disposition === 'attachment') {
    const dispositionParams = bs.dispositionParameters as Record<string, unknown> | undefined;
    const params = bs.parameters as Record<string, unknown> | undefined;
    const name = dispositionParams?.filename ?? params?.name;
    if (typeof name === 'string' && name.length > 0) names.push(name);
  }
  if (Array.isArray(bs.childNodes)) {
    for (const child of bs.childNodes) {
      names.push(...attachmentNames(child));
    }
  }
  return names;
}

/**
 * Pull the References chain out of a raw header subset.
 *
 * The envelope carries only In-Reply-To; the full References header is what
 * lets get_thread walk a conversation without a SEARCH per hop.
 */
function parseReferences(headers?: Buffer): string[] | undefined {
  if (!headers) return undefined;
  const text = headers.toString('utf8');
  // `.` stops at the line end; the group then eats any folded continuation
  // lines (RFC 5322 folding: CRLF followed by whitespace).
  const match = /^references:[ \t]*(.*(?:\r?\n[ \t].*)*)/im.exec(text);
  if (!match) return undefined;
  const ids = match[1]?.match(/<[^>]+>/g);
  return ids && ids.length > 0 ? ids : undefined;
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
    references: parseReferences(msg.headers),
    emailId: msg.emailId,
    internalDate: (msg.internalDate ?? envelope.date ?? new Date()).getTime(),
    subject: envelope.subject,
    fromText: formatSender(envelope.from),
    hasAttachments: hasAttachment(msg.bodyStructure),
    attachmentNames: attachmentNames(msg.bodyStructure),
  };
}

/**
 * Key an (account, mailbox) pair for the in-memory maps.
 *
 * NUL-separated, because mailbox paths routinely contain spaces ("Deleted
 * Items"): a space-joined key makes ("a", "b c") and ("a b", "c") the same
 * entry, silently sharing dirty state and in-flight syncs between two
 * different mailboxes.
 */
function mailboxKey(account: string, mailbox: string): string {
  return `${account}\u0000${mailbox}`;
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

  /**
   * Change-event epochs per mailbox. A mailbox is dirty while its counter is
   * non-zero; a sync snapshots the counter at start and clears it on success
   * only if no further event arrived mid-run — so an event landing during a
   * sync that cannot have observed it keeps the mailbox dirty.
   */
  private dirtyEpochs = new Map<string, number>();

  private listening = false;

  private readonly onReconnect: (event: ReconnectEvent) => void;

  private readonly onNewEmail: (event: NewEmailEvent) => void;

  private readonly onExpunge: (event: ExpungeEvent) => void;

  private readonly onFlags: (event: FlagsEvent) => void;

  private readonly onChanged: (event: MailboxChangedEvent) => void;

  constructor(
    private connections: IConnectionManager,
    private store: CacheStore,
    private options: SyncEngineOptions = {},
  ) {
    this.onReconnect = ({ account }) => {
      this.tiers.delete(account);
      this.tierPending.delete(account);
    };

    // The watcher reports mail arriving, disappearing and changing flags, and
    // ImapService reports this process's own writes. Each is a reason to
    // reconcile, but never a reason to block a tool call, so these are
    // fire-and-forget; the dirty mark is what lets the read path know the
    // mirror is behind until the reconcile lands.
    const react = (account: string, mailbox: string): void => {
      this.markDirty(account, mailbox);
      // syncMailbox never rejects by contract, but an unhandled rejection
      // would take the process down under Node's default — so guard it.
      void this.syncMailbox(account, mailbox).catch(() => {});
    };
    this.onNewEmail = ({ account, mailbox }) => react(account, mailbox);
    this.onExpunge = ({ account, mailbox }) => react(account, mailbox);
    this.onFlags = ({ account, mailbox }) => react(account, mailbox);
    this.onChanged = ({ account, mailbox }) => react(account, mailbox);
  }

  /** Subscribe to change notifications. */
  start(): void {
    if (this.listening) return;
    this.listening = true;
    eventBus.on('imap:reconnect', this.onReconnect);
    eventBus.on('email:new', this.onNewEmail);
    eventBus.on('email:expunge', this.onExpunge);
    eventBus.on('email:flags', this.onFlags);
    eventBus.on('email:changed', this.onChanged);
  }

  stop(): void {
    if (!this.listening) return;
    this.listening = false;
    eventBus.off('imap:reconnect', this.onReconnect);
    eventBus.off('email:new', this.onNewEmail);
    eventBus.off('email:expunge', this.onExpunge);
    eventBus.off('email:flags', this.onFlags);
    eventBus.off('email:changed', this.onChanged);
  }

  // -------------------------------------------------------------------------
  // Dirty tracking
  // -------------------------------------------------------------------------

  /** Record that a mailbox changed and the mirror may be behind. */
  markDirty(account: string, mailbox: string): void {
    const key = mailboxKey(account, mailbox);
    this.dirtyEpochs.set(key, (this.dirtyEpochs.get(key) ?? 0) + 1);
  }

  /** True while a change event has not yet been absorbed by a successful sync. */
  isDirty(account: string, mailbox: string): boolean {
    return (this.dirtyEpochs.get(mailboxKey(account, mailbox)) ?? 0) > 0;
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
    const key = mailboxKey(account, mailbox);
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

    // Snapshot the dirty epoch: events arriving while this run is in flight
    // were not necessarily observed by it and must keep the mailbox dirty.
    const dirtyKey = mailboxKey(account, mailbox);
    const dirtyAtStart = this.dirtyEpochs.get(dirtyKey);

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

        // Baseline servers have no modseq: a flag changed on an existing
        // message (by another client, or by this process between syncs) is
        // invisible to the watermark fetch. RFC 4549's answer is a second,
        // FLAGS-only fetch over what the mirror already holds.
        if (tier === 'baseline' && baseline) {
          result.stored += await this.sweepFlags(client, account, mailbox, uidValidity);
        }

        result.removed += await this.reconcileDeletions(
          client,
          account,
          mailbox,
          uidValidity,
          info.exists,
        );

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
        if (this.dirtyEpochs.get(dirtyKey) === dirtyAtStart) {
          this.dirtyEpochs.delete(dirtyKey);
        }
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
      // The envelope lacks References; fetch just that header for threading.
      headers: ['references'],
      // RFC 8474 EMAILID (X-GM-MSGID on Gmail) — stable across moves. Servers
      // without OBJECTID simply omit it from the response.
      emailId: true,
    };

    let range = '1:*';
    const options: { uid: boolean; changedSince?: bigint } = { uid: true };

    // First sync of a mailbox: bound the initial transfer to the configured
    // window. Incremental syncs ignore the window — their range comes from
    // the stored watermark, and deletions diff only against cached UIDs, so
    // messages older than the window are simply never mirrored.
    const windowDays = this.options.windowDays ?? 0;
    if (!previous && windowDays > 0) {
      const horizon = new Date(Date.now() - windowDays * 86_400_000);
      const inWindow = (await client.search({ since: horizon }, { uid: true })) as number[] | false;
      const [firstInWindow] = inWindow === false ? [] : inWindow;
      if (Array.isArray(inWindow) && firstInWindow !== undefined) {
        // reduce, not Math.min(...uids): spreading more than ~125k arguments
        // throws RangeError, which would make a large mailbox unsyncable.
        range = `${inWindow.reduce((lo, uid) => (uid < lo ? uid : lo), firstInWindow)}:*`;
      } else if (Array.isArray(inWindow)) {
        return 0;
      }
      // A failed probe falls back to the unbounded range: mirroring too much
      // is recoverable, silently mirroring nothing is not.
    }

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

    // Awaited, not fire-and-forget: putMessages yields between write chunks,
    // so awaiting it never stalls the loop while still serializing progress
    // behind this sync's lifecycle.
    await this.store.putMessages(messages);
    return messages.length;
  }

  // -------------------------------------------------------------------------
  // Body backfill
  // -------------------------------------------------------------------------

  /**
   * Download bodies for recently-mirrored messages, newest first.
   *
   * Runs inside the reconcile loop after each sync: up to `batchLimit` per
   * cycle, bounded overall by `bodyMessages` per mailbox. Never throws — a
   * failed backfill leaves the mirror exactly as it was, and every attempted
   * message is marked so failures are not retried every cycle.
   *
   * @returns how many bodies were stored.
   */
  async backfillBodies(account: string, mailbox: string, batchLimit = 25): Promise<number> {
    const budget = this.options.bodyMessages ?? 0;
    if (budget <= 0) return 0;

    try {
      // Stop prefetching once the cache is nearly full, or backfill and the
      // eviction pass spend every cycle undoing each other.
      const maxSizeMb = this.options.maxSizeMb ?? 0;
      if (maxSizeMb > 0) {
        const used = this.store.sizeBytes() + this.store.attachmentUsageBytes();
        if (used > maxSizeMb * 1024 * 1024 * 0.95) return 0;
      }

      const state = this.store.getMailboxState(account, mailbox);
      if (!state || state.lastSyncedAt === undefined) return 0;

      const already = this.store.countBodies(account, mailbox, state.uidValidity);
      const take = Math.min(batchLimit, budget - already);
      if (take <= 0) return 0;

      const uids = this.store.listMissingBodies(account, mailbox, state.uidValidity, take);
      if (uids.length === 0) return 0;

      const client = await this.connections.getImapClient(account);
      const lock = await client.getMailboxLock(mailbox);
      let stored = 0;
      try {
        // Sequential on purpose: ImapFlow runs one command at a time per
        // connection, and backfill must never starve foreground tool calls.
        for (const uid of uids) {
          const ok = await this.fetchBody(client, account, mailbox, state.uidValidity, uid);
          if (ok) stored += 1;
        }
      } finally {
        lock.release();
      }
      return stored;
    } catch (err) {
      await mcpLog(
        'warning',
        'cache',
        `Body backfill failed for ${account}/${mailbox}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return 0;
    }
  }

  /** Download and store one body; mark the row attempted on any dead end. */
  private async fetchBody(
    client: ImapFlow,
    account: string,
    mailbox: string,
    uidValidity: string,
    uid: number,
  ): Promise<boolean> {
    const row = this.store.getMessage(account, mailbox, uid, uidValidity);
    if (!row || row.bodyText !== undefined || row.bodyFetchedAt !== undefined) return false;

    const giveUp = (): false => {
      this.store.markBodyAttempted(account, mailbox, uid, uidValidity);
      return false;
    };

    // Prefer plain for the mirror: it is what search indexes and what an
    // agent reads, and it is far cheaper to store. Passing the cache ceiling
    // lets an over-cap side lose to a sibling that fits.
    const { plain, html } = selectBodyParts(
      collectTextParts(row.bodyStructure),
      MAX_CACHED_BODY_BYTES,
    );
    // A side is a group, not one part: multipart/mixed splits running text
    // across siblings, and storing only the first would mirror a truncated
    // body and index a truncated body for search.
    const chosen = plain.length > 0 ? plain : html;
    if (chosen.length === 0) return giveUp();
    const declaredBytes = chosen.reduce((sum, part) => sum + part.size, 0);
    if (declaredBytes > MAX_CACHED_BODY_BYTES) return giveUp();

    try {
      // Headers ride along so a cached row can serve the full get_email
      // shape (Email.headers is part of the public response).
      const withHeaders = (await client.fetchOne(
        String(uid),
        { uid: true, headers: true },
        { uid: true },
      )) as { headers?: Buffer } | null;
      const headers = withHeaders?.headers ? parseHeaders(withHeaders.headers) : undefined;

      const pieces: string[] = [];
      // Sequential because ImapFlow serialises commands on one connection.
      for (const bodyPart of chosen) {
        // eslint-disable-next-line no-await-in-loop
        const part = await client.download(String(uid), bodyPart.path, { uid: true });
        if (!part?.content) return giveUp();

        const chunks: Buffer[] = [];
        // eslint-disable-next-line no-restricted-syntax
        for await (const chunk of part.content) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        const text = Buffer.concat(chunks).toString('utf-8');
        // Mirror the readable form, not the wire form: a format=flowed body
        // stored with its soft wraps intact would serve hard-wrapped text
        // from the cache and differ from the same message read live.
        pieces.push(bodyPart.flowed ? unflowFormatFlowed(text, bodyPart.delSp) : text);
      }
      const decoded = pieces.join('\n\n');
      if (Buffer.byteLength(decoded, 'utf-8') > MAX_CACHED_BODY_BYTES) return giveUp();

      const subtype = chosen[0]?.subtype === 'html' ? 'html' : 'plain';
      const previewSource = subtype === 'html' ? stripHtml(decoded) : decoded;
      const preview = previewSource.replace(/\s+/g, ' ').trim().slice(0, 200);

      this.store.putBody(account, mailbox, uid, uidValidity, {
        text: decoded,
        subtype,
        headers,
        preview,
      });
      return true;
    } catch {
      return giveUp();
    }
  }

  /**
   * Refresh the flags of already-mirrored messages.
   *
   * FLAGS-only, ranged from the lowest mirrored UID: cheap next to the
   * envelope fetch, and the only way a baseline server ever reveals a flag
   * change on an existing message.
   *
   * @returns how many rows changed.
   */
  private async sweepFlags(
    client: ImapFlow,
    account: string,
    mailbox: string,
    uidValidity: string,
  ): Promise<number> {
    // MIN in SQL rather than spreading every mirrored UID into Math.min,
    // which throws RangeError past ~125k arguments.
    const lowest = this.store.lowestUid(account, mailbox, uidValidity);
    if (lowest === undefined) return 0;

    const range = `${lowest}:*`;
    const entries: { uid: number; flags: string[] }[] = [];
    for await (const msg of client.fetch(range, { uid: true, flags: true }, { uid: true })) {
      const fetched = msg as unknown as { uid?: number; flags?: Set<string> };
      if (typeof fetched.uid !== 'number') continue;
      entries.push({ uid: fetched.uid, flags: [...(fetched.flags ?? new Set<string>())] });
    }

    return this.store.reconcileFlags(account, mailbox, uidValidity, entries);
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
    exists: number | undefined,
  ): Promise<number> {
    const serverUids = (await client.search({ all: true }, { uid: true })) as number[] | false;

    // A failed SEARCH returns false. Treating that as "the mailbox is empty"
    // would delete the entire mirror on a transient error.
    if (!Array.isArray(serverUids)) return 0;

    // SEARCH ALL and the SELECT message count describe the same mailbox, so
    // they must agree. They disagree while a server is rebuilding its index —
    // observed on a live server returning zero UIDs for a mailbox SELECT
    // reported as full. Acting on that deletes the entire mirror for a mailbox
    // that is perfectly intact, so leave deletions for a later sync instead.
    if (typeof exists === 'number' && serverUids.length !== exists) {
      await mcpLog(
        'warning',
        'cache',
        `Skipping deletion pass for ${account}/${mailbox}: SEARCH returned ${serverUids.length} UID(s) but the mailbox reports ${exists} message(s)`,
      );
      return 0;
    }

    const live = new Set(serverUids);
    const cached = this.store.listAllUids(account, mailbox, uidValidity);
    const gone = cached.filter((uid) => !live.has(uid));

    if (gone.length === 0) return 0;

    this.store.deleteMessages(account, mailbox, gone, uidValidity);
    return gone.length;
  }
}
