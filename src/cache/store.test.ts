import CacheStore from './store.js';

function makeMessage(overrides: Record<string, unknown> = {}) {
  return {
    account: 'work',
    mailbox: 'INBOX',
    uid: 1,
    uidValidity: '100',
    envelope: { subject: 'Hello' },
    flags: ['\\Seen'],
    messageId: '<a@example.com>',
    internalDate: Date.parse('2026-08-01T10:00:00Z'),
    subject: 'Hello',
    fromText: 'Ada <ada@example.com>',
    hasAttachments: false,
    ...overrides,
  };
}

describe('CacheStore', () => {
  let store: CacheStore;

  beforeEach(() => {
    store = new CacheStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  describe('messages', () => {
    it('round-trips a message', () => {
      store.putMessages([makeMessage()]);

      const found = store.getMessage('work', 'INBOX', 1, '100');

      expect(found).toMatchObject({
        uid: 1,
        subject: 'Hello',
        flags: ['\\Seen'],
        messageId: '<a@example.com>',
      });
    });

    it('returns undefined for a message from a different UIDVALIDITY', () => {
      store.putMessages([makeMessage({ uidValidity: '100' })]);

      // Same UID, new epoch — this is a different message entirely.
      expect(store.getMessage('work', 'INBOX', 1, '999')).toBeUndefined();
    });

    it('upserts rather than duplicating on re-sync', () => {
      store.putMessages([makeMessage({ flags: ['\\Seen'] })]);
      store.putMessages([makeMessage({ flags: ['\\Seen', '\\Flagged'] })]);

      expect(store.getMessage('work', 'INBOX', 1, '100')?.flags).toEqual(['\\Seen', '\\Flagged']);
      expect(store.countMessages('work', 'INBOX')).toBe(1);
    });

    it('preserves an already-fetched body when re-syncing metadata', () => {
      store.putMessages([makeMessage()]);
      store.putBody('work', 'INBOX', 1, '100', 'the full body text');

      // A metadata resync (e.g. a flag change) must not wipe the body and
      // force another download.
      store.putMessages([makeMessage({ flags: ['\\Seen', '\\Flagged'] })]);

      expect(store.getMessage('work', 'INBOX', 1, '100')?.bodyText).toBe('the full body text');
    });
  });

  describe('pagination', () => {
    beforeEach(() => {
      const base = Date.parse('2026-08-01T10:00:00Z');
      store.putMessages(
        Array.from({ length: 25 }, (_, i) =>
          makeMessage({
            uid: i + 1,
            subject: `Message ${i + 1}`,
            messageId: `<${i + 1}@example.com>`,
            // Ascending dates, so the newest is uid 25.
            internalDate: base + i * 60_000,
          }),
        ),
      );
    });

    it('returns newest first', () => {
      const page = store.listMessages('work', 'INBOX', '100', { page: 1, pageSize: 5 });

      expect(page.items.map((m) => m.uid)).toEqual([25, 24, 23, 22, 21]);
      expect(page.total).toBe(25);
      expect(page.hasMore).toBe(true);
    });

    it('pages deeper without rescanning', () => {
      const page = store.listMessages('work', 'INBOX', '100', { page: 5, pageSize: 5 });

      expect(page.items.map((m) => m.uid)).toEqual([5, 4, 3, 2, 1]);
      expect(page.hasMore).toBe(false);
    });
  });

  describe('full-text search', () => {
    it('finds a message by body text', () => {
      store.putMessages([makeMessage({ uid: 1, subject: 'Rechnung' })]);
      store.putBody('work', 'INBOX', 1, '100', 'Anbei die Rechnung für August.');

      const hits = store.searchMessages('work', 'INBOX', '100', 'Rechnung');

      expect(hits.map((m) => m.uid)).toEqual([1]);
    });

    it('does not return a message after it is purged', () => {
      store.putMessages([makeMessage({ uid: 1 })]);
      store.putBody('work', 'INBOX', 1, '100', 'findable text');
      store.deleteMessages('work', 'INBOX', [1], '100');

      // A stale FTS index would still match here — the triggers must keep the
      // index and the table in step.
      expect(store.searchMessages('work', 'INBOX', '100', 'findable')).toEqual([]);
    });
  });

  describe('mailbox state', () => {
    it('round-trips watermarks including 64-bit values', () => {
      // Beyond Number.MAX_SAFE_INTEGER: must survive as an exact string.
      const bigModseq = '9223372036854775807';
      store.putMailboxState({
        account: 'work',
        mailbox: 'INBOX',
        uidValidity: '100',
        uidNext: 42,
        highestModseq: bigModseq,
        syncTier: 'qresync',
      });

      const state = store.getMailboxState('work', 'INBOX');

      expect(state?.highestModseq).toBe(bigModseq);
      expect(state?.uidNext).toBe(42);
      expect(state?.syncTier).toBe('qresync');
    });

    it('purges every message of the old epoch when UIDVALIDITY changes', () => {
      store.putMailboxState({
        account: 'work',
        mailbox: 'INBOX',
        uidValidity: '100',
        syncTier: 'baseline',
      });
      store.putMessages([makeMessage({ uid: 1 }), makeMessage({ uid: 2 })]);

      const purged = store.resetEpoch('work', 'INBOX', '200');

      expect(purged).toBe(2);
      expect(store.countMessages('work', 'INBOX')).toBe(0);
      expect(store.getMailboxState('work', 'INBOX')?.uidValidity).toBe('200');
    });

    it('leaves other mailboxes untouched when one epoch resets', () => {
      store.putMessages([
        makeMessage({ uid: 1, mailbox: 'INBOX' }),
        makeMessage({ uid: 1, mailbox: 'Archive' }),
      ]);

      store.resetEpoch('work', 'INBOX', '200');

      expect(store.countMessages('work', 'Archive')).toBe(1);
    });
  });
});
