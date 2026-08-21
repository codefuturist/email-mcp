/**
 * Local mirror schema.
 *
 * Two conventions run through this file and both matter:
 *
 * 1. **UIDVALIDITY is the cache epoch.** IMAP guarantees a UID is stable only
 *    for as long as a mailbox's UIDVALIDITY is unchanged. It is denormalized
 *    onto every message row so that invalidating a generation is a single
 *    DELETE rather than a join.
 *
 * 2. **64-bit IMAP counters are stored as TEXT.** `uidValidity` and
 *    `highestModseq` are `bigint` in ImapFlow. SQLite INTEGER would hold them,
 *    but `JSON.stringify` throws on BigInt and `node:sqlite` returns INTEGER as
 *    a JS number by default — which silently loses precision past 2^53. TEXT
 *    round-trips exactly, and these values are only ever compared for equality
 *    or passed back to the server verbatim.
 */

/** Bumped when the statements below change shape. */
export const SCHEMA_VERSION = 1;

export const SCHEMA_SQL = `
-- Per-mailbox sync watermarks.
CREATE TABLE IF NOT EXISTS mailbox_state (
  account         TEXT    NOT NULL,
  mailbox         TEXT    NOT NULL,
  uid_validity    TEXT    NOT NULL,
  uid_next        INTEGER,
  highest_modseq  TEXT,
  sync_tier       TEXT    NOT NULL,
  total_messages  INTEGER,
  unseen_messages INTEGER,
  last_synced_at  INTEGER,
  PRIMARY KEY (account, mailbox)
);

-- Mirrored messages. Envelope and body structure are immutable for a given
-- (uid, uid_validity); flags are not, and are revalidated rather than trusted.
CREATE TABLE IF NOT EXISTS message (
  account             TEXT    NOT NULL,
  mailbox             TEXT    NOT NULL,
  uid                 INTEGER NOT NULL,
  uid_validity        TEXT    NOT NULL,
  modseq              TEXT,
  envelope_json       TEXT    NOT NULL,
  body_structure_json TEXT,
  flags_json          TEXT    NOT NULL,
  message_id          TEXT,
  in_reply_to         TEXT,
  references_json     TEXT,
  internal_date       INTEGER NOT NULL,
  subject             TEXT,
  from_text           TEXT,
  preview             TEXT,
  body_text           TEXT,
  body_fetched_at     INTEGER,
  has_attachments     INTEGER NOT NULL DEFAULT 0,
  cached_at           INTEGER NOT NULL,
  PRIMARY KEY (account, mailbox, uid, uid_validity)
);

-- Serves date-ordered pagination without the client-side slicing the live
-- path uses: page 5 costs the same as page 1.
CREATE INDEX IF NOT EXISTS idx_message_date
  ON message (account, mailbox, internal_date DESC);

-- Serves get_thread and find_email_folder, which otherwise issue one IMAP
-- SEARCH per mailbox or per Message-ID.
CREATE INDEX IF NOT EXISTS idx_message_msgid
  ON message (account, message_id);

-- Offline full-text search. External-content table: FTS5 stores only the
-- index and reads column values back from the message table via rowid, so
-- bodies are not duplicated on disk.
CREATE VIRTUAL TABLE IF NOT EXISTS message_fts USING fts5(
  subject,
  from_text,
  body_text,
  content='message',
  content_rowid='rowid',
  tokenize='porter unicode61'
);

-- External-content FTS5 does not self-sync; these triggers keep the index and
-- the table from drifting. The 'delete' command must be issued with the OLD
-- values, which is why update is expressed as delete-then-insert.
CREATE TRIGGER IF NOT EXISTS message_fts_insert AFTER INSERT ON message BEGIN
  INSERT INTO message_fts (rowid, subject, from_text, body_text)
  VALUES (new.rowid, new.subject, new.from_text, new.body_text);
END;

CREATE TRIGGER IF NOT EXISTS message_fts_delete AFTER DELETE ON message BEGIN
  INSERT INTO message_fts (message_fts, rowid, subject, from_text, body_text)
  VALUES ('delete', old.rowid, old.subject, old.from_text, old.body_text);
END;

CREATE TRIGGER IF NOT EXISTS message_fts_update AFTER UPDATE ON message BEGIN
  INSERT INTO message_fts (message_fts, rowid, subject, from_text, body_text)
  VALUES ('delete', old.rowid, old.subject, old.from_text, old.body_text);
  INSERT INTO message_fts (rowid, subject, from_text, body_text)
  VALUES (new.rowid, new.subject, new.from_text, new.body_text);
END;
`;
