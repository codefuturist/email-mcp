import { describe, expect, it, vi } from 'vitest';
import CacheStore from '../cache/store.js';
import type SyncEngine from '../cache/sync-engine.js';
import type ImapService from './imap.service.js';
import MailReadService from './mail-read.service.js';

const emptyPage = { items: [], total: 0, page: 1, pageSize: 20, hasMore: false };

function createImapStub() {
  return {
    listEmails: vi.fn().mockResolvedValue(emptyPage),
    getEmail: vi.fn().mockResolvedValue({ id: '7', subject: 'hi' }),
    getEmailFlags: vi.fn().mockResolvedValue({ seen: true }),
    searchEmails: vi.fn().mockResolvedValue(emptyPage),
    getThread: vi
      .fn()
      .mockResolvedValue({ threadId: 't', messages: [], participants: [], messageCount: 0 }),
    findEmailFolder: vi.fn().mockResolvedValue({ folders: ['Archive'], messageId: '<m1@x>' }),
    downloadAttachment: vi.fn().mockResolvedValue({
      filename: 'a.pdf',
      mimeType: 'application/pdf',
      size: 1,
      contentBase64: 'QQ==',
    }),
  };
}

function createService(stub = createImapStub()) {
  return { stub, service: new MailReadService(stub as unknown as ImapService) };
}

describe('MailReadService (pass-through)', () => {
  it('delegates listEmails with identical arguments and returns the result', async () => {
    const { stub, service } = createService();
    const options = { mailbox: 'Archive', page: 2, pageSize: 5, seen: false };

    const result = await service.listEmails('work', options);

    expect(stub.listEmails).toHaveBeenCalledExactlyOnceWith('work', options);
    expect(result).toBe(emptyPage);
  });

  it('delegates getEmail with identical arguments and returns the result', async () => {
    const { stub, service } = createService();

    const result = await service.getEmail('work', '42', 'Archive');

    expect(stub.getEmail).toHaveBeenCalledExactlyOnceWith('work', '42', 'Archive');
    expect(result).toEqual({ id: '7', subject: 'hi' });
  });

  it('delegates getEmailFlags with identical arguments and returns the result', async () => {
    const { stub, service } = createService();

    const result = await service.getEmailFlags('work', '42', 'Archive');

    expect(stub.getEmailFlags).toHaveBeenCalledExactlyOnceWith('work', '42', 'Archive');
    expect(result).toEqual({ seen: true });
  });

  it('delegates searchEmails with identical arguments and returns the result', async () => {
    const { stub, service } = createService();
    const options = { mailbox: 'INBOX', hasAttachment: true };

    const result = await service.searchEmails('work', 'invoice', options);

    expect(stub.searchEmails).toHaveBeenCalledExactlyOnceWith('work', 'invoice', options);
    expect(result).toBe(emptyPage);
  });

  it('delegates getThread with identical arguments and returns the result', async () => {
    const { stub, service } = createService();

    const result = await service.getThread('work', '<m1@x>', 'Archive');

    expect(stub.getThread).toHaveBeenCalledExactlyOnceWith('work', '<m1@x>', 'Archive');
    expect(result.threadId).toBe('t');
  });

  it('delegates findEmailFolder with identical arguments and returns the result', async () => {
    const { stub, service } = createService();

    const result = await service.findEmailFolder('work', '42', 'INBOX');

    expect(stub.findEmailFolder).toHaveBeenCalledExactlyOnceWith('work', '42', 'INBOX');
    expect(result.folders).toEqual(['Archive']);
  });

  it('delegates downloadAttachment with identical arguments and returns the result', async () => {
    const { stub, service } = createService();

    const result = await service.downloadAttachment('work', '42', 'INBOX', 'a.pdf', 1024);

    expect(stub.downloadAttachment).toHaveBeenCalledExactlyOnceWith(
      'work',
      '42',
      'INBOX',
      'a.pdf',
      1024,
    );
    expect(result.filename).toBe('a.pdf');
  });
});

// ---------------------------------------------------------------------------
// Cached read path
// ---------------------------------------------------------------------------

async function seedMessages(store: CacheStore) {
  await store.putMessages([
    {
      account: 'work',
      mailbox: 'INBOX',
      uid: 1,
      uidValidity: '100',
      envelope: {
        subject: 'Invoice',
        date: '2026-08-01T10:00:00.000Z',
        from: [{ name: 'Ada', address: 'ada@example.com' }],
        messageId: '<m1@example.com>',
      },
      flags: ['\\Seen', 'Work'],
      messageId: '<m1@example.com>',
      internalDate: Date.parse('2026-08-01T10:00:00Z'),
      subject: 'Invoice',
      fromText: 'Ada <ada@example.com>',
      preview: 'Snippet for one',
      hasAttachments: false,
    },
    {
      account: 'work',
      mailbox: 'INBOX',
      uid: 2,
      uidValidity: '100',
      envelope: {
        subject: 'Lunch',
        date: '2026-08-02T10:00:00.000Z',
        from: [{ address: 'bob@example.com' }],
        messageId: '<m2@example.com>',
      },
      flags: [],
      messageId: '<m2@example.com>',
      internalDate: Date.parse('2026-08-02T10:00:00Z'),
      subject: 'Lunch',
      fromText: 'bob@example.com',
      preview: 'Snippet for two',
      hasAttachments: false,
    },
  ]);
}

function seedState(store: CacheStore, lastSyncedAt: number) {
  store.putMailboxState({
    account: 'work',
    mailbox: 'INBOX',
    uidValidity: '100',
    uidNext: 3,
    syncTier: 'baseline',
    totalMessages: 2,
    lastSyncedAt,
  });
}

function createEngineStub() {
  return {
    syncMailbox: vi.fn().mockResolvedValue({
      ok: true,
      account: 'work',
      mailbox: 'INBOX',
      stored: 0,
      removed: 0,
      epochReset: false,
    }),
    isDirty: vi.fn().mockReturnValue(false),
    markDirty: vi.fn(),
  };
}

async function createCachedSetup(options: { lastSyncedAt?: number; syncWaitMs?: number } = {}) {
  const store = new CacheStore(':memory:');
  await seedMessages(store);
  seedState(store, options.lastSyncedAt ?? Date.now());
  const stub = createImapStub();
  const imap = {
    ...stub,
    getMailboxStatus: vi.fn().mockResolvedValue({ uidValidity: '100', uidNext: 3, messages: 2 }),
  };
  const engine = createEngineStub();
  const service = new MailReadService(
    imap as unknown as ImapService,
    store,
    engine as unknown as SyncEngine,
    { syncWaitMs: options.syncWaitMs ?? 50 },
  );
  return { store, imap, engine, service };
}

describe('MailReadService (cached reads)', () => {
  it('serves a fresh mirror without touching the network', async () => {
    const { imap, engine, service } = await createCachedSetup();

    const result = await service.listEmails('work', { mailbox: 'INBOX' });

    expect(result.items.map((m) => m.id)).toEqual(['2', '1']);
    expect(result.total).toBe(2);
    expect(result.cache).toEqual({ source: 'cache' });
    expect(imap.listEmails).not.toHaveBeenCalled();
    expect(imap.getMailboxStatus).not.toHaveBeenCalled();
    expect(engine.syncMailbox).not.toHaveBeenCalled();
  });

  it('maps cached rows to the live EmailMeta shape', async () => {
    const { service } = await createCachedSetup();

    const { items } = await service.listEmails('work', { mailbox: 'INBOX' });
    const invoice = items.find((m) => m.id === '1');

    expect(invoice).toMatchObject({
      id: '1',
      subject: 'Invoice',
      from: { name: 'Ada', address: 'ada@example.com' },
      date: '2026-08-01T10:00:00.000Z',
      seen: true,
      flagged: false,
      answered: false,
      labels: ['Work'],
    });
  });

  it('applies filters to the cached listing', async () => {
    const { service } = await createCachedSetup();

    const result = await service.listEmails('work', { mailbox: 'INBOX', seen: false });

    expect(result.items.map((m) => m.id)).toEqual(['2']);
    expect(result.total).toBe(1);
  });

  it('revalidates with one STATUS once the debounce has passed', async () => {
    const { imap, engine, service, store } = await createCachedSetup({
      lastSyncedAt: Date.now() - 60_000,
    });

    const result = await service.listEmails('work', { mailbox: 'INBOX' });

    expect(result.cache).toEqual({ source: 'cache' });
    expect(imap.getMailboxStatus).toHaveBeenCalledExactlyOnceWith('work', 'INBOX');
    expect(engine.syncMailbox).not.toHaveBeenCalled();
    expect(imap.listEmails).not.toHaveBeenCalled();
    // The confirmation counts as a sync for debounce purposes.
    expect(store.getMailboxState('work', 'INBOX')?.lastSyncedAt).toBeGreaterThan(
      Date.now() - 5_000,
    );
  });

  it('syncs before serving when STATUS reports a change', async () => {
    const { imap, engine, service } = await createCachedSetup({
      lastSyncedAt: Date.now() - 60_000,
    });
    imap.getMailboxStatus.mockResolvedValue({ uidValidity: '100', uidNext: 7, messages: 3 });

    const result = await service.listEmails('work', { mailbox: 'INBOX' });

    expect(engine.syncMailbox).toHaveBeenCalledExactlyOnceWith('work', 'INBOX');
    expect(result.cache).toEqual({ source: 'cache' });
  });

  it('treats an uncomparable STATUS as changed', async () => {
    const { imap, engine, service } = await createCachedSetup({
      lastSyncedAt: Date.now() - 60_000,
    });
    // A server that reports none of the comparable fields gives no evidence
    // the mirror is current — that must trigger a sync, never a cache hit.
    imap.getMailboxStatus.mockResolvedValue({});

    await service.listEmails('work', { mailbox: 'INBOX' });

    expect(engine.syncMailbox).toHaveBeenCalled();
  });

  it('serves stale with a marker when the sync exceeds the bounded wait', async () => {
    const { imap, engine, service } = await createCachedSetup({
      lastSyncedAt: Date.now() - 60_000,
      syncWaitMs: 5,
    });
    imap.getMailboxStatus.mockResolvedValue({ uidValidity: '100', uidNext: 7, messages: 3 });
    engine.syncMailbox.mockReturnValue(new Promise(() => {}));

    const result = await service.listEmails('work', { mailbox: 'INBOX' });

    expect(result.cache).toEqual({ source: 'cache', stale: true });
    expect(result.items).toHaveLength(2);
  });

  it('serves the mirror flagged offline when IMAP is unreachable', async () => {
    const { imap, service } = await createCachedSetup({ lastSyncedAt: Date.now() - 60_000 });
    imap.getMailboxStatus.mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await service.listEmails('work', { mailbox: 'INBOX' });

    expect(result.cache).toEqual({ source: 'cache', offline: true });
    expect(result.items).toHaveLength(2);
    expect(imap.listEmails).not.toHaveBeenCalled();
  });

  it('flags the result offline when the awaited sync fails', async () => {
    const { imap, engine, service } = await createCachedSetup({
      lastSyncedAt: Date.now() - 60_000,
    });
    imap.getMailboxStatus.mockResolvedValue({ uidValidity: '100', uidNext: 7, messages: 3 });
    engine.syncMailbox.mockResolvedValue({
      ok: false,
      account: 'work',
      mailbox: 'INBOX',
      stored: 0,
      removed: 0,
      epochReset: false,
      error: 'ECONNRESET',
    });

    const result = await service.listEmails('work', { mailbox: 'INBOX' });

    expect(result.cache).toEqual({ source: 'cache', offline: true });
  });

  it('falls back to live for a mailbox the mirror has never synced', async () => {
    const { imap, engine, service } = await createCachedSetup();

    const result = await service.listEmails('work', { mailbox: 'Archive' });

    expect(imap.listEmails).toHaveBeenCalledExactlyOnceWith('work', { mailbox: 'Archive' });
    expect(result.cache).toBeUndefined();
    // The read warms the mirror for next time.
    expect(engine.syncMailbox).toHaveBeenCalledExactlyOnceWith('work', 'Archive');
  });

  it('bypasses the debounce when the mailbox is dirty', async () => {
    const { engine, service } = await createCachedSetup({ lastSyncedAt: Date.now() });
    engine.isDirty.mockReturnValue(true);

    await service.listEmails('work', { mailbox: 'INBOX' });

    expect(engine.syncMailbox).toHaveBeenCalledExactlyOnceWith('work', 'INBOX');
  });

  it('serves email flags from the mirror', async () => {
    const { imap, service } = await createCachedSetup();

    const flags = await service.getEmailFlags('work', '1', 'INBOX');

    expect(flags).toMatchObject({
      seen: true,
      flagged: false,
      answered: false,
      labels: ['Work'],
      subject: 'Invoice',
      from: 'Ada <ada@example.com>',
    });
    expect(imap.getEmailFlags).not.toHaveBeenCalled();
  });

  it('falls back to live flags when the message is not mirrored', async () => {
    const { imap, service } = await createCachedSetup();

    await service.getEmailFlags('work', '999', 'INBOX');

    expect(imap.getEmailFlags).toHaveBeenCalledExactlyOnceWith('work', '999', 'INBOX');
  });
});

describe('MailReadService (cached bodies)', () => {
  function fullLiveEmail(body: Partial<Record<string, unknown>> = {}) {
    return {
      id: '1',
      subject: 'Invoice',
      from: { name: 'Ada', address: 'ada@example.com' },
      to: [],
      date: '2026-08-01T10:00:00.000Z',
      seen: true,
      flagged: false,
      answered: false,
      hasAttachments: false,
      labels: ['Work'],
      cc: [],
      bcc: [],
      bodyText: 'fresh body',
      messageId: '<m1@example.com>',
      attachments: [],
      headers: { subject: 'Invoice' },
      ...body,
    };
  }

  it('serves a fully cached message without touching the network', async () => {
    const { store, imap, service } = await createCachedSetup();
    store.putBody('work', 'INBOX', 1, '100', {
      text: 'Anbei die Rechnung.',
      subtype: 'plain',
      headers: { subject: 'Invoice', references: '<r1@x> <r2@x>' },
      preview: 'Anbei die Rechnung.',
    });

    const email = await service.getEmail('work', '1', 'INBOX');

    expect(imap.getEmail).not.toHaveBeenCalled();
    expect(email).toMatchObject({
      id: '1',
      subject: 'Invoice',
      from: { name: 'Ada', address: 'ada@example.com' },
      seen: true,
      labels: ['Work'],
      bodyText: 'Anbei die Rechnung.',
      messageId: '<m1@example.com>',
      references: ['<r1@x>', '<r2@x>'],
      headers: { subject: 'Invoice', references: '<r1@x> <r2@x>' },
    });
    expect(email.bodyHtml).toBeUndefined();
    expect(email.attachments).toEqual([]);
    expect(store.getMessage('work', 'INBOX', 1, '100')?.lastAccessedAt).toBeDefined();
  });

  it('maps a cached html body to bodyHtml', async () => {
    const { store, service } = await createCachedSetup();
    store.putBody('work', 'INBOX', 2, '100', {
      text: '<p>Hi</p>',
      subtype: 'html',
      headers: {},
    });

    const email = await service.getEmail('work', '2', 'INBOX');

    expect(email.bodyHtml).toBe('<p>Hi</p>');
    expect(email.bodyText).toBeUndefined();
  });

  it('fetches live on a body miss and persists the result for the next read', async () => {
    const { store, imap, service } = await createCachedSetup();
    imap.getEmail.mockResolvedValue(fullLiveEmail());

    const first = await service.getEmail('work', '1', 'INBOX');
    expect(first.bodyText).toBe('fresh body');
    expect(imap.getEmail).toHaveBeenCalledTimes(1);

    const row = store.getMessage('work', 'INBOX', 1, '100');
    expect(row?.bodyText).toBe('fresh body');
    expect(row?.headers).toEqual({ subject: 'Invoice' });
    expect(row?.preview).toBe('fresh body');

    const second = await service.getEmail('work', '1', 'INBOX');
    expect(imap.getEmail).toHaveBeenCalledTimes(1);
    expect(second.bodyText).toBe('fresh body');
  });

  it('does not persist an oversized body and does not retry it in backfill', async () => {
    const { store, imap, service } = await createCachedSetup();
    imap.getEmail.mockResolvedValue(fullLiveEmail({ bodyText: 'x'.repeat(300 * 1024) }));

    await service.getEmail('work', '1', 'INBOX');

    const row = store.getMessage('work', 'INBOX', 1, '100');
    expect(row?.bodyText).toBeUndefined();
    expect(store.listMissingBodies('work', 'INBOX', '100', 10)).not.toContain(1);
  });

  it('coalesces concurrent fetches of the same message', async () => {
    const { imap, service } = await createCachedSetup();
    imap.getEmail.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(fullLiveEmail()), 5)),
    );

    const [a, b] = await Promise.all([
      service.getEmail('work', '1', 'INBOX'),
      service.getEmail('work', '1', 'INBOX'),
    ]);

    expect(imap.getEmail).toHaveBeenCalledTimes(1);
    expect(a.bodyText).toBe('fresh body');
    expect(b.bodyText).toBe('fresh body');
  });
});

describe('MailReadService (cached search)', () => {
  it('serves a full-text query from the mirror', async () => {
    const { store, imap, service } = await createCachedSetup();
    store.putBody('work', 'INBOX', 1, '100', { text: 'Anbei die Rechnung fuer August.' });

    const result = await service.searchEmails('work', 'Rechnung', { mailbox: 'INBOX' });

    expect(imap.searchEmails).not.toHaveBeenCalled();
    expect(result.items.map((m) => m.id)).toEqual(['1']);
    expect(result.total).toBe(1);
    expect(result.cache).toEqual({ source: 'cache' });
  });

  it('serves a filter-only search (no query) from the mirror', async () => {
    const { imap, service } = await createCachedSetup();

    const result = await service.searchEmails('work', '', {
      mailbox: 'INBOX',
      hasAttachment: false,
    });

    expect(imap.searchEmails).not.toHaveBeenCalled();
    expect(result.items.map((m) => m.id)).toEqual(['2', '1']);
  });

  it('falls through to live search when the mirror finds nothing', async () => {
    const { imap, service } = await createCachedSetup();

    // Recall gap: bodies not yet backfilled, so a body term cannot match.
    await service.searchEmails('work', 'Nebelkraehe', { mailbox: 'INBOX' });

    expect(imap.searchEmails).toHaveBeenCalledExactlyOnceWith('work', 'Nebelkraehe', {
      mailbox: 'INBOX',
    });
  });

  it('always goes live for filters the mirror cannot evaluate', async () => {
    const { imap, service } = await createCachedSetup();

    await service.searchEmails('work', 'Invoice', { mailbox: 'INBOX', to: 'x@example.com' });
    await service.searchEmails('work', 'Invoice', { mailbox: 'INBOX', largerThan: 10 });
    await service.searchEmails('work', 'Invoice', { mailbox: 'INBOX', smallerThan: 10 });
    await service.searchEmails('work', 'Invoice', { mailbox: 'INBOX', from: 'a@example.com' });
    await service.searchEmails('work', 'Invoice', {
      mailbox: 'INBOX',
      since: '2026-05-01T00:00:00Z',
    });
    await service.searchEmails('work', 'Invoice', {
      mailbox: 'INBOX',
      before: '2026-05-01T00:00:00Z',
    });
    await service.searchEmails('work', 'Invoice', {
      mailbox: 'INBOX',
      sentSince: '2026-05-01T00:00:00Z',
    });
    await service.searchEmails('work', 'Invoice', {
      mailbox: 'INBOX',
      sentBefore: '2026-05-01T00:00:00Z',
    });

    expect(imap.searchEmails).toHaveBeenCalledTimes(8);
  });

  it('pages cached search results', async () => {
    const { store, service } = await createCachedSetup();
    store.putBody('work', 'INBOX', 1, '100', { text: 'Rechnung eins' });
    store.putBody('work', 'INBOX', 2, '100', { text: 'Rechnung zwei' });

    const page = await service.searchEmails('work', 'Rechnung', {
      mailbox: 'INBOX',
      page: 1,
      pageSize: 1,
    });

    expect(page.items).toHaveLength(1);
    expect(page.total).toBe(2);
    expect(page.hasMore).toBe(true);
  });
});

describe('MailReadService (cached thread)', () => {
  async function seedThread(store: CacheStore) {
    const base = Date.parse('2026-09-01T10:00:00Z');
    await store.putMessages([
      {
        account: 'work',
        mailbox: 'INBOX',
        uid: 10,
        uidValidity: '100',
        envelope: { subject: 'Plan', date: new Date(base).toISOString(), messageId: '<t1@x>' },
        flags: [],
        messageId: '<t1@x>',
        internalDate: base,
        subject: 'Plan',
        hasAttachments: false,
      },
      {
        account: 'work',
        mailbox: 'INBOX',
        uid: 11,
        uidValidity: '100',
        envelope: {
          subject: 'Re: Plan',
          date: new Date(base + 1000).toISOString(),
          messageId: '<t2@x>',
        },
        flags: [],
        messageId: '<t2@x>',
        inReplyTo: '<t1@x>',
        internalDate: base + 1000,
        subject: 'Re: Plan',
        hasAttachments: false,
      },
    ]);
    store.putBody('work', 'INBOX', 10, '100', { text: 'first', headers: {} });
    store.putBody('work', 'INBOX', 11, '100', { text: 'second', headers: {} });
  }

  it('assembles a thread from the mirror without any IMAP search', async () => {
    const { store, imap, service } = await createCachedSetup();
    await seedThread(store);

    const thread = await service.getThread('work', '<t1@x>', 'INBOX');

    expect(imap.getThread).not.toHaveBeenCalled();
    expect(imap.getEmail).not.toHaveBeenCalled();
    expect(thread.messageCount).toBe(2);
    expect(thread.messages.map((m) => m.bodyText)).toEqual(['first', 'second']);
    expect(thread.threadId).toBe('<t1@x>');
  });

  it('live-fetches thread members whose body is not mirrored yet', async () => {
    const { store, imap, service } = await createCachedSetup();
    await seedThread(store);
    await store.putMessages([
      {
        account: 'work',
        mailbox: 'INBOX',
        uid: 12,
        uidValidity: '100',
        envelope: { subject: 'Re: Plan', messageId: '<t3@x>' },
        flags: [],
        messageId: '<t3@x>',
        inReplyTo: '<t2@x>',
        internalDate: Date.parse('2026-09-01T10:00:02Z'),
        subject: 'Re: Plan',
        hasAttachments: false,
      },
    ]);
    imap.getEmail.mockResolvedValue({
      id: '12',
      subject: 'Re: Plan',
      from: { address: 'x@example.com' },
      to: [],
      date: '2026-09-01T10:00:02.000Z',
      seen: false,
      flagged: false,
      answered: false,
      hasAttachments: false,
      labels: [],
      bodyText: 'third',
      messageId: '<t3@x>',
      attachments: [],
      headers: {},
    });

    const thread = await service.getThread('work', '<t1@x>', 'INBOX');

    expect(imap.getThread).not.toHaveBeenCalled();
    expect(imap.getEmail).toHaveBeenCalledExactlyOnceWith('work', '12', 'INBOX');
    expect(thread.messages.map((m) => m.bodyText)).toEqual(['first', 'second', 'third']);
  });

  it('falls back to the live thread walk when the root is unknown to the mirror', async () => {
    const { service, imap } = await createCachedSetup();

    await service.getThread('work', '<absent@x>', 'INBOX');

    expect(imap.getThread).toHaveBeenCalledExactlyOnceWith('work', '<absent@x>', 'INBOX');
  });
});

describe('MailReadService (locate)', () => {
  it('resolves the Message-ID from the mirror and still verifies folders live', async () => {
    const { imap, service } = await createCachedSetup();

    const result = await service.findEmailFolder('work', '1', 'INBOX');

    // The folder list must stay live: a partial mirror would omit folders,
    // and a missing folder here misdirects a later move or delete.
    expect(imap.findEmailFolder).toHaveBeenCalledExactlyOnceWith('work', '1', 'INBOX');
    expect(result.folders).toEqual(['Archive']);
  });
});

describe('MailReadService (cached attachments)', () => {
  async function createAttachmentSetup() {
    const base = await createCachedSetup();
    const blobs = new Map<string, Buffer>();
    const blobStore = {
      put: vi.fn(async (content: Buffer) => {
        const { createHash } = await import('node:crypto');
        const sha256 = createHash('sha256').update(content).digest('hex');
        blobs.set(sha256, content);
        return { sha256, size: content.length };
      }),
      get: vi.fn(async (sha256: string) => blobs.get(sha256)),
      delete: vi.fn(async (sha256: string) => {
        blobs.delete(sha256);
      }),
    };
    const service = new MailReadService(
      base.imap as unknown as ImapService,
      base.store,
      base.engine as unknown as SyncEngine,
      { syncWaitMs: 50 },
      blobStore as never,
    );
    return { ...base, blobs, blobStore, service };
  }

  const liveAttachment = {
    filename: 'report.pdf',
    mimeType: 'application/pdf',
    size: 5,
    contentBase64: Buffer.from('bytes').toString('base64'),
  };

  it('downloads once and serves the repeat read from the blob store', async () => {
    const { imap, blobStore, service } = await createAttachmentSetup();
    imap.downloadAttachment.mockResolvedValue(liveAttachment);

    const first = await service.downloadAttachment('work', '1', 'INBOX', 'report.pdf');
    const second = await service.downloadAttachment('work', '1', 'INBOX', 'report.pdf');

    expect(imap.downloadAttachment).toHaveBeenCalledTimes(1);
    expect(blobStore.put).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
    expect(second.contentBase64).toBe(liveAttachment.contentBase64);
  });

  it('deduplicates identical content across messages', async () => {
    const { imap, blobs, service } = await createAttachmentSetup();
    imap.downloadAttachment.mockResolvedValue(liveAttachment);

    await service.downloadAttachment('work', '1', 'INBOX', 'report.pdf');
    await service.downloadAttachment('work', '2', 'INBOX', 'report.pdf');

    expect(blobs.size).toBe(1);
  });

  it('re-downloads when the indexed blob has vanished', async () => {
    const { imap, blobs, service } = await createAttachmentSetup();
    imap.downloadAttachment.mockResolvedValue(liveAttachment);
    await service.downloadAttachment('work', '1', 'INBOX', 'report.pdf');

    // The XDG cache dir may be wiped at any moment; the index outliving the
    // bytes must degrade to a live download, never to an error.
    blobs.clear();

    const again = await service.downloadAttachment('work', '1', 'INBOX', 'report.pdf');

    expect(imap.downloadAttachment).toHaveBeenCalledTimes(2);
    expect(again.contentBase64).toBe(liveAttachment.contentBase64);
  });

  it('does not cache an attachment from an unmirrored mailbox', async () => {
    const { imap, blobStore, service } = await createAttachmentSetup();
    imap.downloadAttachment.mockResolvedValue(liveAttachment);

    await service.downloadAttachment('work', '1', 'Archive', 'report.pdf');

    expect(blobStore.put).not.toHaveBeenCalled();
  });

  it('passes the caller size cap through to the live download', async () => {
    const { imap, service } = await createAttachmentSetup();
    imap.downloadAttachment.mockResolvedValue(liveAttachment);

    await service.downloadAttachment('work', '1', 'INBOX', 'report.pdf', 2048);

    expect(imap.downloadAttachment).toHaveBeenCalledExactlyOnceWith(
      'work',
      '1',
      'INBOX',
      'report.pdf',
      2048,
    );
  });

  it('serves a cached attachment even when IMAP is unreachable', async () => {
    const { imap, service } = await createAttachmentSetup();
    imap.downloadAttachment.mockResolvedValue(liveAttachment);
    await service.downloadAttachment('work', '1', 'INBOX', 'report.pdf');

    imap.downloadAttachment.mockRejectedValue(new Error('ECONNREFUSED'));
    imap.getMailboxStatus.mockRejectedValue(new Error('ECONNREFUSED'));

    const offline = await service.downloadAttachment('work', '1', 'INBOX', 'report.pdf');

    expect(offline.contentBase64).toBe(liveAttachment.contentBase64);
  });
});

describe('MailReadService (review fixes)', () => {
  it('falls back to live when the mirror does not cover the whole mailbox', async () => {
    const { store, imap, service } = await createCachedSetup();
    // The server says 9000 messages; the mirror holds 2 (a window-bounded
    // first sync). Serving that as a complete listing reports total: 2 and
    // "no more pages" for a mailbox full of older mail.
    store.putMailboxState({
      account: 'work',
      mailbox: 'INBOX',
      uidValidity: '100',
      uidNext: 3,
      syncTier: 'baseline',
      totalMessages: 9000,
      lastSyncedAt: Date.now(),
    });

    const result = await service.listEmails('work', { mailbox: 'INBOX' });

    expect(imap.listEmails).toHaveBeenCalledExactlyOnceWith('work', { mailbox: 'INBOX' });
    expect(result.cache).toBeUndefined();
  });

  it('still serves the mirror when it covers the mailbox', async () => {
    const { imap, service } = await createCachedSetup();

    const result = await service.listEmails('work', { mailbox: 'INBOX' });

    expect(imap.listEmails).not.toHaveBeenCalled();
    expect(result.cache).toEqual({ source: 'cache' });
  });

  it('sends a partial-coverage search to the live path too', async () => {
    const { store, imap, service } = await createCachedSetup();
    store.putBody('work', 'INBOX', 1, '100', { text: 'Rechnung August' });
    store.putMailboxState({
      account: 'work',
      mailbox: 'INBOX',
      uidValidity: '100',
      uidNext: 3,
      syncTier: 'baseline',
      totalMessages: 9000,
      lastSyncedAt: Date.now(),
    });

    await service.searchEmails('work', 'Rechnung', { mailbox: 'INBOX' });

    expect(imap.searchEmails).toHaveBeenCalled();
  });

  it('writes a live-fetched body against the epoch the read was served from', async () => {
    const { store, imap, service } = await createCachedSetup();
    imap.getEmail.mockImplementation(async () => {
      // A concurrent sync rotates the epoch while the fetch is in flight.
      store.resetEpoch('work', 'INBOX', '200');
      await store.putMessages([
        {
          account: 'work',
          mailbox: 'INBOX',
          uid: 1,
          uidValidity: '200',
          envelope: { subject: 'A DIFFERENT MESSAGE' },
          flags: [],
          messageId: '<other@example.com>',
          internalDate: Date.now(),
          subject: 'A DIFFERENT MESSAGE',
          hasAttachments: false,
        },
      ]);
      return {
        id: '1',
        subject: 'Invoice',
        from: { name: 'Ada', address: 'ada@example.com' },
        to: [],
        date: '2026-08-01T10:00:00.000Z',
        seen: true,
        flagged: false,
        answered: false,
        hasAttachments: false,
        labels: [],
        bodyText: 'body of the ORIGINAL message',
        messageId: '<m1@example.com>',
        attachments: [],
        headers: {},
      };
    });

    await service.getEmail('work', '1', 'INBOX');

    // The fill must die on the old epoch key, never graft one message's body
    // onto a different message that now holds the same UID.
    expect(store.getMessage('work', 'INBOX', 1, '200')?.bodyText).toBeUndefined();
  });

  it('marks the mailbox dirty before awaiting a sync, so a coalesced run cannot pass as complete', async () => {
    const { imap, engine, service } = await createCachedSetup({
      lastSyncedAt: Date.now() - 60_000,
    });
    imap.getMailboxStatus.mockResolvedValue({ uidValidity: '100', uidNext: 7, messages: 3 });

    await service.listEmails('work', { mailbox: 'INBOX' });

    expect(engine.markDirty).toHaveBeenCalledWith('work', 'INBOX');
  });

  it('degrades to the live path when the mirror itself errors', async () => {
    const { store, imap, service } = await createCachedSetup();
    // A locked or corrupt database must not surface as a tool error.
    store.close();

    const result = await service.listEmails('work', { mailbox: 'INBOX' });

    expect(imap.listEmails).toHaveBeenCalled();
    expect(result.cache).toBeUndefined();
  });

  it('serves a preview for cached listings even before any body is stored', async () => {
    const { service } = await createCachedSetup();

    const { items } = await service.listEmails('work', { mailbox: 'INBOX' });

    // The live path derives a preview from a 256-byte source fetch; without
    // one, list_emails output silently loses its snippet line.
    expect(items.find((m) => m.id === '1')?.preview).toBe('Snippet for one');
  });

  it('includes cc recipients and folds address case in thread participants', async () => {
    const { store, imap, service } = await createCachedSetup();
    await store.putMessages([
      {
        account: 'work',
        mailbox: 'INBOX',
        uid: 20,
        uidValidity: '100',
        envelope: {
          subject: 'Plan',
          messageId: '<p1@x>',
          from: [{ address: 'Ada@Example.com' }],
          to: [{ address: 'bob@example.com' }],
          cc: [{ address: 'carol@example.com' }],
        },
        flags: [],
        messageId: '<p1@x>',
        internalDate: Date.now(),
        subject: 'Plan',
        hasAttachments: false,
      },
      {
        account: 'work',
        mailbox: 'INBOX',
        uid: 21,
        uidValidity: '100',
        envelope: {
          subject: 'Re: Plan',
          messageId: '<p2@x>',
          from: [{ address: 'ada@example.com' }],
          to: [],
        },
        flags: [],
        messageId: '<p2@x>',
        inReplyTo: '<p1@x>',
        internalDate: Date.now() + 1000,
        subject: 'Re: Plan',
        hasAttachments: false,
      },
    ]);
    store.putBody('work', 'INBOX', 20, '100', { text: 'a', headers: {} });
    store.putBody('work', 'INBOX', 21, '100', { text: 'b', headers: {} });

    const thread = await service.getThread('work', '<p1@x>', 'INBOX');

    expect(imap.getThread).not.toHaveBeenCalled();
    const addresses = thread.participants.map((p) => p.address);
    expect(addresses).toContain('carol@example.com');
    // Ada appears once despite differing case between the two messages.
    expect(addresses.filter((a) => a.toLowerCase() === 'ada@example.com')).toHaveLength(1);
  });

  it('issues one STATUS probe for a batch of concurrent reads', async () => {
    const { imap, service } = await createCachedSetup({ lastSyncedAt: Date.now() - 60_000 });

    await Promise.all([
      service.getEmail('work', '1', 'INBOX'),
      service.getEmail('work', '2', 'INBOX'),
      service.listEmails('work', { mailbox: 'INBOX' }),
    ]);

    expect(imap.getMailboxStatus).toHaveBeenCalledTimes(1);
  });
});
