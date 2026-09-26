import type { IConnectionManager } from '../connections/types.js';
import eventBus from '../services/event-bus.js';
import CacheStore from './store.js';
import SyncEngine from './sync-engine.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

interface MockMessage {
  uid: number;
  envelope?: Record<string, unknown>;
  flags?: Set<string>;
  modseq?: bigint;
  bodyStructure?: unknown;
  internalDate?: Date;
}

/**
 * Shapes mirror what a real server returns — verified against a live IMAP
 * server: `uidValidity` and `highestModseq` are bigint, and `highestModseq`
 * is absent entirely when the server lacks CONDSTORE.
 */
/** ImapFlow exposes capabilities as a Map, not a Set (imap-flow.d.ts:761). */
function capabilityMap(names: string[]): Map<string, boolean | number> {
  return new Map(names.map((n) => [n, true]));
}

function createMockClient(options: { capabilities?: string[] } = {}) {
  const release = vi.fn();
  return {
    capabilities: capabilityMap(options.capabilities ?? []),
    mailbox: {
      uidValidity: 100n,
      uidNext: 10,
      exists: 3,
      highestModseq: undefined as bigint | undefined,
    },
    getMailboxLock: vi.fn().mockResolvedValue({ release }),
    mailboxOpen: vi.fn(),
    search: vi.fn().mockResolvedValue([]),
    fetch: vi.fn().mockImplementation(() => (async function* none() {})()),
    status: vi.fn().mockResolvedValue({}),
    _release: release,
  };
}

function messagesFrom(...messages: MockMessage[]) {
  return () =>
    (async function* gen() {
      for (const m of messages) {
        yield {
          uid: m.uid,
          envelope: m.envelope ?? { subject: `Subject ${m.uid}`, date: new Date('2026-08-01') },
          flags: m.flags ?? new Set(['\\Seen']),
          modseq: m.modseq,
          bodyStructure: m.bodyStructure ?? { type: 'text/plain', size: 10 },
          internalDate: m.internalDate ?? new Date('2026-08-01'),
        };
      }
    })();
}

function createConnections(client: ReturnType<typeof createMockClient>) {
  return {
    getAccount: vi.fn().mockReturnValue({ name: 'work' }),
    getAccountNames: vi.fn().mockReturnValue(['work']),
    getImapClient: vi.fn().mockResolvedValue(client),
    getSmtpTransport: vi.fn(),
    closeAll: vi.fn(),
  } as unknown as IConnectionManager;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SyncEngine', () => {
  let store: CacheStore;
  let client: ReturnType<typeof createMockClient>;
  let engine: SyncEngine;

  function build(capabilities: string[] = []): SyncEngine {
    client = createMockClient({ capabilities });
    return new SyncEngine(createConnections(client), store);
  }

  beforeEach(() => {
    store = new CacheStore(':memory:');
  });

  afterEach(() => {
    engine?.stop();
    store.close();
    eventBus.removeAllListeners();
  });

  // -------------------------------------------------------------------------
  // Capability tiers
  // -------------------------------------------------------------------------

  describe('tier detection', () => {
    it('uses qresync when the server advertises it', async () => {
      engine = build(['QRESYNC', 'CONDSTORE']);
      expect(await engine.detectTier('work')).toBe('qresync');
    });

    it('falls back to condstore when qresync is absent', async () => {
      // This is Gmail: it advertises CONDSTORE and X-GM-EXT-1 but never
      // QRESYNC, so it cannot report expunges via modseq.
      engine = build(['CONDSTORE', 'X-GM-EXT-1']);
      expect(await engine.detectTier('work')).toBe('condstore');
    });

    it('falls back to baseline when neither is advertised', async () => {
      engine = build(['IMAP4rev1', 'IDLE', 'MOVE']);
      expect(await engine.detectTier('work')).toBe('baseline');
    });

    it('probes the connection only once per account', async () => {
      client = createMockClient({ capabilities: ['QRESYNC'] });
      const connections = createConnections(client);
      engine = new SyncEngine(connections, store);

      await engine.detectTier('work');
      await engine.detectTier('work');

      expect(connections.getImapClient).toHaveBeenCalledTimes(1);
    });

    it('deduplicates concurrent probes for the same account', async () => {
      client = createMockClient({ capabilities: ['QRESYNC'] });
      const connections = createConnections(client);
      engine = new SyncEngine(connections, store);

      const [a, b] = await Promise.all([engine.detectTier('work'), engine.detectTier('work')]);

      expect(a).toBe('qresync');
      expect(b).toBe('qresync');
      expect(connections.getImapClient).toHaveBeenCalledTimes(1);
    });

    it('re-probes after a reconnect', async () => {
      client = createMockClient({ capabilities: ['QRESYNC'] });
      const connections = createConnections(client);
      engine = new SyncEngine(connections, store);
      engine.start();

      expect(await engine.detectTier('work')).toBe('qresync');

      // A reconnect may land on a different server for the same account, so
      // capabilities probed against the old connection cannot be trusted.
      client.capabilities = capabilityMap(['IMAP4rev1']);
      eventBus.emit('imap:reconnect', { account: 'work' });

      expect(await engine.detectTier('work')).toBe('baseline');
    });
  });

  // -------------------------------------------------------------------------
  // UIDVALIDITY epoch
  // -------------------------------------------------------------------------

  describe('UIDVALIDITY epoch', () => {
    it('records the epoch on first sync', async () => {
      engine = build();
      client.search.mockResolvedValue([]);

      await engine.syncMailbox('work', 'INBOX');

      expect(store.getMailboxState('work', 'INBOX')?.uidValidity).toBe('100');
    });

    it('purges the mirror when UIDVALIDITY changes', async () => {
      engine = build();
      client.fetch.mockImplementation(messagesFrom({ uid: 1 }, { uid: 2 }));
      client.search.mockResolvedValue([1, 2]);
      await engine.syncMailbox('work', 'INBOX');
      expect(store.countMessages('work', 'INBOX')).toBe(2);

      // The mailbox was recreated server-side: every cached UID now refers to
      // a different message, so the whole generation must go.
      client.mailbox.uidValidity = 999n;
      client.mailbox.uidNext = 1;
      client.fetch.mockImplementation(messagesFrom());
      client.search.mockResolvedValue([]);
      await engine.syncMailbox('work', 'INBOX');

      expect(store.countMessages('work', 'INBOX')).toBe(0);
      expect(store.getMailboxState('work', 'INBOX')?.uidValidity).toBe('999');
    });

    it('keeps the mirror when UIDVALIDITY is unchanged', async () => {
      engine = build();
      client.fetch.mockImplementation(messagesFrom({ uid: 1 }));
      client.search.mockResolvedValue([1]);
      await engine.syncMailbox('work', 'INBOX');

      client.fetch.mockImplementation(messagesFrom());
      await engine.syncMailbox('work', 'INBOX');

      expect(store.countMessages('work', 'INBOX')).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // Baseline tier
  // -------------------------------------------------------------------------

  describe('baseline tier', () => {
    it('stores fetched messages', async () => {
      engine = build();
      client.fetch.mockImplementation(messagesFrom({ uid: 5 }, { uid: 6 }));
      client.search.mockResolvedValue([5, 6]);

      await engine.syncMailbox('work', 'INBOX');

      expect(store.getMessage('work', 'INBOX', 5, '100')).toBeDefined();
      expect(store.getMessage('work', 'INBOX', 6, '100')).toBeDefined();
    });

    it('only fetches above the stored watermark on a second sync', async () => {
      engine = build();
      client.fetch.mockImplementation(messagesFrom({ uid: 5 }));
      client.search.mockResolvedValue([5]);
      await engine.syncMailbox('work', 'INBOX');

      client.mailbox.uidNext = 20;
      client.fetch.mockClear();
      client.fetch.mockImplementation(messagesFrom({ uid: 15 }));
      client.search.mockResolvedValue([5, 15]);
      await engine.syncMailbox('work', 'INBOX');

      // Refetching from 1 would re-download the entire mailbox every sync.
      const [range] = client.fetch.mock.calls[0];
      expect(range).toBe('10:*');
    });

    it('removes messages the server no longer lists', async () => {
      engine = build();
      client.fetch.mockImplementation(messagesFrom({ uid: 1 }, { uid: 2 }, { uid: 3 }));
      client.search.mockResolvedValue([1, 2, 3]);
      client.mailbox.exists = 3;
      await engine.syncMailbox('work', 'INBOX');

      // uid 2 was deleted by another client. Without a UID-set diff a
      // baseline-tier server gives no signal at all, and the mirror would
      // keep serving a message that no longer exists. `exists` moves with the
      // search result, as it does on a server that is not mid-resync.
      client.fetch.mockImplementation(messagesFrom());
      client.search.mockResolvedValue([1, 3]);
      client.mailbox.exists = 2;
      await engine.syncMailbox('work', 'INBOX');

      expect(store.getMessage('work', 'INBOX', 2, '100')).toBeUndefined();
      expect(store.countMessages('work', 'INBOX')).toBe(2);
    });
  });

  // -------------------------------------------------------------------------
  // CONDSTORE tier
  // -------------------------------------------------------------------------

  describe('condstore tier', () => {
    it('passes changedSince once a modseq watermark exists', async () => {
      engine = build(['CONDSTORE']);
      client.mailbox.highestModseq = 500n;
      client.fetch.mockImplementation(messagesFrom({ uid: 1, modseq: 400n }));
      client.search.mockResolvedValue([1]);
      await engine.syncMailbox('work', 'INBOX');

      expect(store.getMailboxState('work', 'INBOX')?.highestModseq).toBe('500');

      client.mailbox.highestModseq = 700n;
      client.fetch.mockClear();
      client.fetch.mockImplementation(messagesFrom({ uid: 1, modseq: 650n }));
      await engine.syncMailbox('work', 'INBOX');

      const changedSince = client.fetch.mock.calls.at(-1)?.[2]?.changedSince;
      expect(changedSince).toBe(500n);
    });

    it('picks up a flag change made by another client', async () => {
      engine = build(['CONDSTORE']);
      client.mailbox.highestModseq = 500n;
      client.fetch.mockImplementation(
        messagesFrom({ uid: 1, flags: new Set(['\\Seen']), modseq: 400n }),
      );
      client.search.mockResolvedValue([1]);
      await engine.syncMailbox('work', 'INBOX');
      expect(store.getMessage('work', 'INBOX', 1, '100')?.flags).toEqual(['\\Seen']);

      client.mailbox.highestModseq = 700n;
      client.fetch.mockImplementation(
        messagesFrom({ uid: 1, flags: new Set(['\\Seen', '\\Flagged']), modseq: 650n }),
      );
      await engine.syncMailbox('work', 'INBOX');

      expect(store.getMessage('work', 'INBOX', 1, '100')?.flags).toEqual(['\\Seen', '\\Flagged']);
    });
  });

  // -------------------------------------------------------------------------
  // Resilience
  // -------------------------------------------------------------------------

  describe('deletion reconciliation safety', () => {
    async function seedThree(): Promise<void> {
      client.fetch.mockImplementation(messagesFrom({ uid: 1 }, { uid: 2 }, { uid: 3 }));
      client.search.mockResolvedValue([1, 2, 3]);
      client.mailbox.exists = 3;
      await engine.syncMailbox('work', 'INBOX');
    }

    it('does not purge the mirror when the server reports an empty mailbox it should not', async () => {
      engine = build();
      await seedThree();
      expect(store.countMessages('work', 'INBOX')).toBe(3);

      // Observed against a real server mid-resync: SEARCH returns nothing
      // while SELECT still reports messages present. Believing SEARCH here
      // deletes the entire mirror for a mailbox that is perfectly intact.
      client.search.mockResolvedValue([]);
      client.mailbox.exists = 3;
      client.fetch.mockImplementation(messagesFrom());
      await engine.syncMailbox('work', 'INBOX');

      expect(store.countMessages('work', 'INBOX')).toBe(3);
    });

    it('still removes messages when SEARCH and SELECT agree', async () => {
      engine = build();
      await seedThree();

      // Genuine deletion: both the search result and the message count drop.
      client.search.mockResolvedValue([1, 3]);
      client.mailbox.exists = 2;
      client.fetch.mockImplementation(messagesFrom());
      await engine.syncMailbox('work', 'INBOX');

      expect(store.countMessages('work', 'INBOX')).toBe(2);
      expect(store.getMessage('work', 'INBOX', 2, '100')).toBeUndefined();
    });

    it('accepts a genuinely emptied mailbox', async () => {
      engine = build();
      await seedThree();

      client.search.mockResolvedValue([]);
      client.mailbox.exists = 0;
      client.fetch.mockImplementation(messagesFrom());
      await engine.syncMailbox('work', 'INBOX');

      expect(store.countMessages('work', 'INBOX')).toBe(0);
    });
  });

  describe('resilience', () => {
    it('leaves existing rows in place when a sync fails', async () => {
      engine = build();
      client.fetch.mockImplementation(messagesFrom({ uid: 1 }));
      client.search.mockResolvedValue([1]);
      await engine.syncMailbox('work', 'INBOX');

      client.getMailboxLock.mockRejectedValue(new Error('ECONNRESET'));

      // A stale row still answers a question; a deleted one cannot. Sync
      // failures must never escalate into data loss.
      await expect(engine.syncMailbox('work', 'INBOX')).resolves.toBeDefined();
      expect(store.countMessages('work', 'INBOX')).toBe(1);
    });

    it('reports failure rather than throwing', async () => {
      engine = build();
      client.getMailboxLock.mockRejectedValue(new Error('ECONNRESET'));

      const result = await engine.syncMailbox('work', 'INBOX');

      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/ECONNRESET/);
    });

    it('releases the mailbox lock even when the fetch throws', async () => {
      engine = build();
      client.fetch.mockImplementation(() => {
        throw new Error('mid-stream failure');
      });

      await engine.syncMailbox('work', 'INBOX');

      expect(client._release).toHaveBeenCalled();
    });
  });
});
