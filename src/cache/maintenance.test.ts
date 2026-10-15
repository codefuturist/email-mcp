import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import BlobStore from './blob-store.js';
import { collectOrphans, enforceBudget } from './maintenance.js';
import CacheStore from './store.js';

function makeMessage(uid: number, overrides: Record<string, unknown> = {}) {
  return {
    account: 'work',
    mailbox: 'INBOX',
    uid,
    uidValidity: '100',
    envelope: { subject: `Subject ${uid}` },
    flags: [],
    messageId: `<${uid}@x>`,
    internalDate: Date.parse('2026-08-01T10:00:00Z') + uid * 1000,
    subject: `Subject ${uid}`,
    hasAttachments: false,
    ...overrides,
  };
}

async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'maintenance-'));
  const store = new CacheStore(':memory:');
  const blobs = new BlobStore(root);
  store.putMailboxState({
    account: 'work',
    mailbox: 'INBOX',
    uidValidity: '100',
    syncTier: 'baseline',
    lastSyncedAt: Date.now(),
  });
  return { root, store, blobs };
}

describe('enforceBudget', async () => {
  it('does nothing while usage is inside the budget', async () => {
    const { store, blobs } = await setup();
    await store.putMessages([makeMessage(1)]);

    const result = await enforceBudget(store, blobs, 500);

    expect(result).toMatchObject({ evictedBlobs: 0, evictedBodies: 0, evictedMessages: 0 });
    expect(store.countMessages('work', 'INBOX')).toBe(1);
    store.close();
  });

  it('evicts least-recently-used attachment blobs first', async () => {
    const { store, blobs } = await setup();
    await store.putMessages([makeMessage(1), makeMessage(2)]);
    const cold = await blobs.put(Buffer.alloc(600 * 1024, 1));
    const warm = await blobs.put(Buffer.alloc(600 * 1024, 2));
    store.putAttachment({
      account: 'work',
      mailbox: 'INBOX',
      uid: 1,
      uidValidity: '100',
      partId: 'cold.bin',
      filename: 'cold.bin',
      mimeType: 'application/octet-stream',
      size: cold.size,
      sha256: cold.sha256,
    });
    store.putAttachment({
      account: 'work',
      mailbox: 'INBOX',
      uid: 2,
      uidValidity: '100',
      partId: 'warm.bin',
      filename: 'warm.bin',
      mimeType: 'application/octet-stream',
      size: warm.size,
      sha256: warm.sha256,
    });
    store.touchAttachment('work', 'INBOX', 2, '100', 'warm.bin');

    const result = await enforceBudget(store, blobs, 1);

    expect(result.evictedBlobs).toBeGreaterThan(0);
    // Envelopes survive: they are cheap and are what listings need.
    expect(store.countMessages('work', 'INBOX')).toBe(2);
    // The recently-read blob outlives the untouched one.
    expect(await blobs.get(cold.sha256)).toBeUndefined();
    expect(store.getAttachment('work', 'INBOX', 1, '100', 'cold.bin')).toBeUndefined();
    store.close();
  });

  it('keeps shared content until its last reference is evicted', async () => {
    const { store, blobs } = await setup();
    await store.putMessages([makeMessage(1), makeMessage(2)]);
    const shared = await blobs.put(Buffer.alloc(900 * 1024, 7));
    for (const uid of [1, 2]) {
      store.putAttachment({
        account: 'work',
        mailbox: 'INBOX',
        uid,
        uidValidity: '100',
        partId: 'shared.bin',
        filename: 'shared.bin',
        mimeType: 'application/octet-stream',
        size: shared.size,
        sha256: shared.sha256,
      });
    }

    await enforceBudget(store, blobs, 1, { lowWaterRatio: 0.5 });

    // Both index rows gone ⇒ the blob may go. One row left ⇒ it must stay.
    const remaining = store.countBlobRefs(shared.sha256);
    const held = await blobs.get(shared.sha256);
    expect(remaining > 0 ? held !== undefined : held === undefined).toBe(true);
    store.close();
  });

  it('drops bodies before envelopes once blobs are gone', async () => {
    const { store, blobs } = await setup();
    const big = 'x'.repeat(100 * 1024);
    await store.putMessages([makeMessage(1), makeMessage(2), makeMessage(3), makeMessage(4)]);
    for (const uid of [1, 2, 3, 4]) {
      store.putBody('work', 'INBOX', uid, '100', { text: big });
    }
    // Reading uid 4 makes it the warmest, so it is evicted last.
    store.touchAccess('work', 'INBOX', '100', [4]);

    // Budget just under what is held, so only the coldest bodies go — which
    // is what makes the eviction *order* observable rather than a full drain.
    const budgetMb = (store.sizeBytes() * 0.95) / 1024 / 1024;
    const result = await enforceBudget(store, blobs, budgetMb);

    expect(result.evictedBodies).toBeGreaterThan(0);
    expect(result.usedBytesAfter).toBeLessThan(result.usedBytesBefore);
    // Envelopes survive: they are cheap and are what listings need.
    expect(store.countMessages('work', 'INBOX')).toBe(4);
    // Coldest loses its body; the one that was read keeps it.
    expect(store.getMessage('work', 'INBOX', 1, '100')?.bodyText).toBeUndefined();
    expect(store.getMessage('work', 'INBOX', 4, '100')?.bodyText).toBe(big);
    // An evicted body must be re-fetchable, not marked as already attempted.
    expect(store.listMissingBodies('work', 'INBOX', '100', 10)).toContain(1);
    store.close();
  });

  it('keeps the full-text index consistent with evicted bodies', async () => {
    const { store, blobs } = await setup();
    await store.putMessages([makeMessage(1), makeMessage(2)]);
    store.putBody('work', 'INBOX', 1, '100', { text: `Nebelkraehe ${'x'.repeat(200 * 1024)}` });
    store.putBody('work', 'INBOX', 2, '100', { text: `Nebelkraehe ${'y'.repeat(200 * 1024)}` });
    expect(store.searchMessages('work', 'INBOX', '100', 'Nebelkraehe')).toHaveLength(2);

    const budgetMb = store.sizeBytes() / 8 / 1024 / 1024;
    await enforceBudget(store, blobs, budgetMb);

    // Bodies are gone, so their terms must no longer match; subjects still do.
    expect(store.searchMessages('work', 'INBOX', '100', 'Nebelkraehe')).toEqual([]);
    expect(store.searchMessages('work', 'INBOX', '100', 'Subject')).toHaveLength(2);
    store.close();
  });
});

describe('collectOrphans', async () => {
  it('removes blobs the index no longer references', async () => {
    const { store, blobs } = await setup();
    const orphan = await blobs.put(Buffer.from('orphaned'));
    const referenced = await blobs.put(Buffer.from('referenced'));
    await store.putMessages([makeMessage(1)]);
    store.putAttachment({
      account: 'work',
      mailbox: 'INBOX',
      uid: 1,
      uidValidity: '100',
      partId: 'keep.bin',
      filename: 'keep.bin',
      mimeType: 'application/octet-stream',
      size: referenced.size,
      sha256: referenced.sha256,
    });

    const removed = await collectOrphans(store, blobs);

    expect(removed).toBe(1);
    expect(await blobs.get(orphan.sha256)).toBeUndefined();
    expect(await blobs.get(referenced.sha256)).toBeDefined();
    store.close();
  });

  it('drops index rows whose content has vanished', async () => {
    const { store, blobs } = await setup();
    await store.putMessages([makeMessage(1)]);
    store.putAttachment({
      account: 'work',
      mailbox: 'INBOX',
      uid: 1,
      uidValidity: '100',
      partId: 'gone.bin',
      filename: 'gone.bin',
      mimeType: 'application/octet-stream',
      size: 10,
      sha256: 'f'.repeat(64),
    });

    await collectOrphans(store, blobs);

    expect(store.getAttachment('work', 'INBOX', 1, '100', 'gone.bin')).toBeUndefined();
    store.close();
  });
});

describe('review fixes: maintenance', async () => {
  it('measures usage from the index, not by walking the blob directory', async () => {
    const { store, blobs } = await setup();
    await store.putMessages([makeMessage(1)]);
    const { sha256, size } = await blobs.put(Buffer.alloc(300 * 1024, 3));
    store.putAttachment({
      account: 'work',
      mailbox: 'INBOX',
      uid: 1,
      uidValidity: '100',
      partId: 'a.bin',
      filename: 'a.bin',
      mimeType: 'application/octet-stream',
      size,
      sha256,
    });
    // A synchronous stat-per-blob walk on every pass blocks the event loop of
    // a stdio MCP server; the index already knows the byte total.
    const walk = vi.spyOn(blobs, 'sizeBytes');

    const result = await enforceBudget(store, blobs, 500);

    expect(walk).not.toHaveBeenCalled();
    expect(result.usedBytesBefore).toBeGreaterThanOrEqual(300 * 1024);
    walk.mockRestore();
    store.close();
  });

  it('reclaims blobs whose messages were expunged', async () => {
    const { store, blobs } = await setup();
    await store.putMessages([makeMessage(1)]);
    const { sha256, size } = await blobs.put(Buffer.from('attached bytes'));
    store.putAttachment({
      account: 'work',
      mailbox: 'INBOX',
      uid: 1,
      uidValidity: '100',
      partId: 'a.bin',
      filename: 'a.bin',
      mimeType: 'application/octet-stream',
      size,
      sha256,
    });

    store.deleteMessages('work', 'INBOX', [1], '100');
    const removed = await collectOrphans(store, blobs);

    expect(removed).toBe(1);
    expect(await blobs.get(sha256)).toBeUndefined();
    store.close();
  });
});
