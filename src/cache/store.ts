/**
 * SQLite-backed local mirror of server-side mail.
 *
 * Uses `node:sqlite`, built into Node 24 — no native module, no install step,
 * nothing to rebuild across Node or architecture changes. The project already
 * requires Node >= 24, so this adds zero runtime dependencies.
 *
 * This class is deliberately dumb: it stores and retrieves rows and knows
 * nothing about IMAP. Reconciliation lives in the sync engine, and hit/stale/
 * offline policy lives in the cached service wrapper.
 */

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_SQL, SCHEMA_VERSION } from './schema.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SyncTier = 'qresync' | 'condstore' | 'baseline';

/** A message as handed to the store for persistence. */
export interface CachedMessageInput {
  account: string;
  mailbox: string;
  uid: number;
  /** Cache epoch, as a decimal string — see schema.ts. */
  uidValidity: string;
  modseq?: string;
  envelope: unknown;
  bodyStructure?: unknown;
  flags: string[];
  messageId?: string;
  inReplyTo?: string;
  references?: string[];
  /** Epoch milliseconds. */
  internalDate: number;
  subject?: string;
  fromText?: string;
  preview?: string;
  hasAttachments: boolean;
}

/** A message as read back out of the mirror. */
export interface CachedMessage {
  account: string;
  mailbox: string;
  uid: number;
  uidValidity: string;
  modseq?: string;
  envelope: unknown;
  bodyStructure?: unknown;
  flags: string[];
  messageId?: string;
  inReplyTo?: string;
  references?: string[];
  internalDate: number;
  subject?: string;
  fromText?: string;
  preview?: string;
  bodyText?: string;
  bodyFetchedAt?: number;
  hasAttachments: boolean;
  cachedAt: number;
}

export interface MailboxState {
  account: string;
  mailbox: string;
  uidValidity: string;
  uidNext?: number;
  highestModseq?: string;
  syncTier: SyncTier;
  totalMessages?: number;
  unseenMessages?: number;
  lastSyncedAt?: number;
}

export interface PageOptions {
  page: number;
  pageSize: number;
}

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}

/** Raw row shape as returned by SQLite. */
interface MailboxStateRow {
  account: string;
  mailbox: string;
  uid_validity: string;
  uid_next: number | null;
  highest_modseq: string | null;
  sync_tier: string;
  total_messages: number | null;
  unseen_messages: number | null;
  last_synced_at: number | null;
}

interface MessageRow {
  account: string;
  mailbox: string;
  uid: number;
  uid_validity: string;
  modseq: string | null;
  envelope_json: string;
  body_structure_json: string | null;
  flags_json: string;
  message_id: string | null;
  in_reply_to: string | null;
  references_json: string | null;
  internal_date: number;
  subject: string | null;
  from_text: string | null;
  preview: string | null;
  body_text: string | null;
  body_fetched_at: number | null;
  has_attachments: number;
  cached_at: number;
}

function rowToMessage(row: MessageRow): CachedMessage {
  return {
    account: row.account,
    mailbox: row.mailbox,
    uid: row.uid,
    uidValidity: row.uid_validity,
    modseq: row.modseq ?? undefined,
    envelope: JSON.parse(row.envelope_json),
    bodyStructure: row.body_structure_json ? JSON.parse(row.body_structure_json) : undefined,
    flags: JSON.parse(row.flags_json),
    messageId: row.message_id ?? undefined,
    inReplyTo: row.in_reply_to ?? undefined,
    references: row.references_json ? JSON.parse(row.references_json) : undefined,
    internalDate: row.internal_date,
    subject: row.subject ?? undefined,
    fromText: row.from_text ?? undefined,
    preview: row.preview ?? undefined,
    bodyText: row.body_text ?? undefined,
    bodyFetchedAt: row.body_fetched_at ?? undefined,
    hasAttachments: row.has_attachments === 1,
    cachedAt: row.cached_at,
  };
}

/**
 * Escape a user query for FTS5 MATCH.
 *
 * FTS5 has its own query syntax where bare `-`, `*`, `"` and `:` are
 * operators. Users type mail search terms, not FTS5 expressions, so each token
 * is quoted and treated literally rather than risking a syntax error on a
 * subject line like "Re: Q3 -- draft".
 */
function toFtsQuery(query: string): string {
  const tokens = query.match(/[\p{L}\p{N}_]+/gu) ?? [];
  return tokens.map((t) => `"${t}"`).join(' ');
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export default class CacheStore {
  private db: DatabaseSync;

  /**
   * @param dbPath filesystem path, or ':memory:' for tests.
   */
  constructor(dbPath: string) {
    if (dbPath !== ':memory:') {
      // 0700: the mirror holds message bodies, so it is owner-only. This plus
      // full-disk encryption is the documented at-rest posture.
      fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
    }

    // `timeout` sets busy_timeout, so concurrent readers wait rather than
    // failing immediately with SQLITE_BUSY.
    this.db = new DatabaseSync(dbPath, { timeout: 5000 });

    // WAL lets readers proceed during a write — important because sync runs in
    // the background while tool calls read. NORMAL trades an fsync per commit
    // for a small crash window, which is the right call for regenerable data.
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.db.exec('PRAGMA foreign_keys = ON');

    this.migrate();

    if (dbPath !== ':memory:') {
      fs.chmodSync(dbPath, 0o600);
    }
  }

  /**
   * Apply the schema, rebuilding from scratch if the file was written by a
   * newer build. The mirror is regenerable, so discarding it is always safe
   * and is preferable to failing at startup.
   */
  private migrate(): void {
    const { user_version: version } = this.db.prepare('PRAGMA user_version').get() as {
      user_version: number;
    };

    if (version > SCHEMA_VERSION) {
      this.db.exec('DROP TABLE IF EXISTS message_fts');
      this.db.exec('DROP TABLE IF EXISTS message');
      this.db.exec('DROP TABLE IF EXISTS mailbox_state');
      this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    }

    this.db.exec(SCHEMA_SQL);
    this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }

  /**
   * Run `fn` inside an immediate transaction.
   *
   * BEGIN IMMEDIATE rather than the default deferred: busy_timeout does not
   * apply when a read transaction tries to upgrade to a write, which is the
   * usual source of spurious SQLITE_BUSY errors.
   */
  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /**
   * Query helpers.
   *
   * `node:sqlite` types rows as `Record<string, SQLOutputValue>`, which never
   * structurally overlaps a concrete row interface. The cast is unavoidable;
   * confining it to these two helpers keeps it from spreading across every
   * query, and the row interfaces stay the single description of table shape.
   */
  private queryAll<T>(sql: string, ...params: (string | number | null)[]): T[] {
    return this.db.prepare(sql).all(...params) as unknown as T[];
  }

  private queryOne<T>(sql: string, ...params: (string | number | null)[]): T | undefined {
    return this.db.prepare(sql).get(...params) as unknown as T | undefined;
  }

  close(): void {
    this.db.close();
  }

  // -------------------------------------------------------------------------
  // Messages
  // -------------------------------------------------------------------------

  /**
   * Insert or update messages.
   *
   * An already-downloaded body is preserved: a metadata resync (a flag change,
   * say) must not discard content and force a second download.
   */
  putMessages(messages: CachedMessageInput[]): void {
    if (messages.length === 0) return;

    const stmt = this.db.prepare(`
      INSERT INTO message (
        account, mailbox, uid, uid_validity, modseq,
        envelope_json, body_structure_json, flags_json,
        message_id, in_reply_to, references_json,
        internal_date, subject, from_text, preview,
        has_attachments, cached_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (account, mailbox, uid, uid_validity) DO UPDATE SET
        modseq              = excluded.modseq,
        envelope_json       = excluded.envelope_json,
        body_structure_json = excluded.body_structure_json,
        flags_json          = excluded.flags_json,
        message_id          = excluded.message_id,
        in_reply_to         = excluded.in_reply_to,
        references_json     = excluded.references_json,
        internal_date       = excluded.internal_date,
        subject             = excluded.subject,
        from_text           = excluded.from_text,
        preview             = excluded.preview,
        has_attachments     = excluded.has_attachments,
        cached_at           = excluded.cached_at
    `);

    const now = Date.now();
    this.transaction(() => {
      messages.forEach((m) => {
        stmt.run(
          m.account,
          m.mailbox,
          m.uid,
          m.uidValidity,
          m.modseq ?? null,
          JSON.stringify(m.envelope),
          m.bodyStructure ? JSON.stringify(m.bodyStructure) : null,
          JSON.stringify(m.flags),
          m.messageId ?? null,
          m.inReplyTo ?? null,
          m.references ? JSON.stringify(m.references) : null,
          m.internalDate,
          m.subject ?? null,
          m.fromText ?? null,
          m.preview ?? null,
          m.hasAttachments ? 1 : 0,
          now,
        );
      });
    });
  }

  /** Attach a downloaded body to an existing message. */
  putBody(
    account: string,
    mailbox: string,
    uid: number,
    uidValidity: string,
    bodyText: string,
  ): void {
    this.db
      .prepare(`
        UPDATE message SET body_text = ?, body_fetched_at = ?
        WHERE account = ? AND mailbox = ? AND uid = ? AND uid_validity = ?
      `)
      .run(bodyText, Date.now(), account, mailbox, uid, uidValidity);
  }

  getMessage(
    account: string,
    mailbox: string,
    uid: number,
    uidValidity: string,
  ): CachedMessage | undefined {
    const row = this.queryOne<MessageRow>(
      `SELECT * FROM message
       WHERE account = ? AND mailbox = ? AND uid = ? AND uid_validity = ?`,
      account,
      mailbox,
      uid,
      uidValidity,
    );

    return row ? rowToMessage(row) : undefined;
  }

  /** Look a message up by Message-ID across every mailbox of an account. */
  findByMessageId(account: string, messageId: string): CachedMessage[] {
    return this.queryAll<MessageRow>(
      'SELECT * FROM message WHERE account = ? AND message_id = ?',
      account,
      messageId,
    ).map(rowToMessage);
  }

  /** Newest-first page. Costs the same at page 50 as at page 1. */
  listMessages(
    account: string,
    mailbox: string,
    uidValidity: string,
    options: PageOptions,
  ): Page<CachedMessage> {
    const { page, pageSize } = options;
    const offset = (page - 1) * pageSize;

    const total =
      this.queryOne<{ total: number }>(
        `SELECT COUNT(*) AS total FROM message
         WHERE account = ? AND mailbox = ? AND uid_validity = ?`,
        account,
        mailbox,
        uidValidity,
      )?.total ?? 0;

    const rows = this.queryAll<MessageRow>(
      `SELECT * FROM message
       WHERE account = ? AND mailbox = ? AND uid_validity = ?
       ORDER BY internal_date DESC
       LIMIT ? OFFSET ?`,
      account,
      mailbox,
      uidValidity,
      pageSize,
      offset,
    );

    return {
      items: rows.map(rowToMessage),
      total,
      page,
      pageSize,
      hasMore: offset + rows.length < total,
    };
  }

  /** Full-text search over subject, sender and body, ranked by bm25. */
  searchMessages(
    account: string,
    mailbox: string,
    uidValidity: string,
    query: string,
    limit = 100,
  ): CachedMessage[] {
    const ftsQuery = toFtsQuery(query);
    if (ftsQuery.length === 0) return [];

    return this.queryAll<MessageRow>(
      `SELECT m.* FROM message_fts f
       JOIN message m ON m.rowid = f.rowid
       WHERE message_fts MATCH ?
         AND m.account = ? AND m.mailbox = ? AND m.uid_validity = ?
       ORDER BY bm25(message_fts)
       LIMIT ?`,
      ftsQuery,
      account,
      mailbox,
      uidValidity,
      limit,
    ).map(rowToMessage);
  }

  /**
   * Every cached UID for one mailbox generation.
   *
   * Used by the sync engine to diff against the server's UID set, which on a
   * server without QRESYNC is the only way a deletion is ever detected.
   */
  listAllUids(account: string, mailbox: string, uidValidity: string): number[] {
    return this.queryAll<{ uid: number }>(
      `SELECT uid FROM message
       WHERE account = ? AND mailbox = ? AND uid_validity = ?`,
      account,
      mailbox,
      uidValidity,
    ).map((r) => r.uid);
  }

  countMessages(account: string, mailbox: string): number {
    return (
      this.queryOne<{ total: number }>(
        'SELECT COUNT(*) AS total FROM message WHERE account = ? AND mailbox = ?',
        account,
        mailbox,
      )?.total ?? 0
    );
  }

  deleteMessages(account: string, mailbox: string, uids: number[], uidValidity: string): void {
    if (uids.length === 0) return;

    const stmt = this.db.prepare(`
      DELETE FROM message
      WHERE account = ? AND mailbox = ? AND uid = ? AND uid_validity = ?
    `);

    this.transaction(() => {
      uids.forEach((uid) => {
        stmt.run(account, mailbox, uid, uidValidity);
      });
    });
  }

  // -------------------------------------------------------------------------
  // Mailbox state
  // -------------------------------------------------------------------------

  putMailboxState(state: MailboxState): void {
    this.db
      .prepare(`
        INSERT INTO mailbox_state (
          account, mailbox, uid_validity, uid_next, highest_modseq,
          sync_tier, total_messages, unseen_messages, last_synced_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (account, mailbox) DO UPDATE SET
          uid_validity    = excluded.uid_validity,
          uid_next        = excluded.uid_next,
          highest_modseq  = excluded.highest_modseq,
          sync_tier       = excluded.sync_tier,
          total_messages  = excluded.total_messages,
          unseen_messages = excluded.unseen_messages,
          last_synced_at  = excluded.last_synced_at
      `)
      .run(
        state.account,
        state.mailbox,
        state.uidValidity,
        state.uidNext ?? null,
        state.highestModseq ?? null,
        state.syncTier,
        state.totalMessages ?? null,
        state.unseenMessages ?? null,
        state.lastSyncedAt ?? Date.now(),
      );
  }

  getMailboxState(account: string, mailbox: string): MailboxState | undefined {
    const row = this.queryOne<MailboxStateRow>(
      'SELECT * FROM mailbox_state WHERE account = ? AND mailbox = ?',
      account,
      mailbox,
    );

    if (!row) return undefined;

    return {
      account: row.account,
      mailbox: row.mailbox,
      uidValidity: row.uid_validity,
      uidNext: row.uid_next ?? undefined,
      highestModseq: row.highest_modseq ?? undefined,
      syncTier: row.sync_tier as SyncTier,
      totalMessages: row.total_messages ?? undefined,
      unseenMessages: row.unseen_messages ?? undefined,
      lastSyncedAt: row.last_synced_at ?? undefined,
    };
  }

  /**
   * Start a new cache epoch for a mailbox.
   *
   * Called when the server reports a UIDVALIDITY different from the stored
   * one: every cached UID for that mailbox now refers to a different message,
   * so the generation is dropped wholesale.
   *
   * @returns how many messages were discarded.
   */
  resetEpoch(account: string, mailbox: string, newUidValidity: string): number {
    return this.transaction(() => {
      const { changes } = this.db
        .prepare(`
          DELETE FROM message
          WHERE account = ? AND mailbox = ? AND uid_validity <> ?
        `)
        .run(account, mailbox, newUidValidity);

      this.db
        .prepare(`
          INSERT INTO mailbox_state (account, mailbox, uid_validity, sync_tier)
          VALUES (?, ?, ?, 'baseline')
          ON CONFLICT (account, mailbox) DO UPDATE SET
            uid_validity   = excluded.uid_validity,
            uid_next       = NULL,
            highest_modseq = NULL
        `)
        .run(account, mailbox, newUidValidity);

      return Number(changes);
    });
  }

  // -------------------------------------------------------------------------
  // Maintenance
  // -------------------------------------------------------------------------

  /** Drop mirrored mail. Never touches the outbox, which is a separate file. */
  clear(account?: string): void {
    this.transaction(() => {
      if (account) {
        this.db.prepare('DELETE FROM message WHERE account = ?').run(account);
        this.db.prepare('DELETE FROM mailbox_state WHERE account = ?').run(account);
      } else {
        this.db.exec('DELETE FROM message');
        this.db.exec('DELETE FROM mailbox_state');
      }
    });
  }

  /** On-disk size in bytes, for `cache status`. */
  sizeBytes(): number {
    return (
      this.queryOne<{ size: number }>(
        'SELECT page_count * page_size AS size FROM pragma_page_count(), pragma_page_size()',
      )?.size ?? 0
    );
  }
}
