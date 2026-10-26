import { mkdtempSync, rmSync } from 'node:fs';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { IConnectionManager } from '../connections/types.js';
import eventBus from './event-bus.js';
import ImapService from './imap.service.js';

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function createMockImapClient() {
  const releaseFn = vi.fn();
  return {
    usable: true,
    capabilities: new Set<string>(),
    getMailboxLock: vi.fn().mockResolvedValue({ release: releaseFn }),
    list: vi.fn().mockResolvedValue([]),
    status: vi.fn().mockResolvedValue({ messages: 5, unseen: 2 }),
    fetch: vi.fn().mockReturnValue((async function* fetchMock() {})()),
    fetchOne: vi.fn().mockResolvedValue(null),
    download: vi.fn().mockResolvedValue(null),
    search: vi.fn().mockResolvedValue([]),
    messageMove: vi.fn().mockResolvedValue(true),
    messageDelete: vi.fn().mockResolvedValue(true),
    messageFlagsAdd: vi.fn().mockResolvedValue(true),
    messageFlagsRemove: vi.fn().mockResolvedValue(true),
    mailboxCreate: vi.fn().mockResolvedValue({ path: 'X' }),
    mailboxRename: vi.fn().mockResolvedValue({ path: 'X' }),
    mailboxDelete: vi.fn().mockResolvedValue({ path: 'X' }),
    append: vi.fn().mockResolvedValue({ uid: 1 }),
    _releaseFn: releaseFn,
  };
}

function createMockConnectionManager(mockClient: ReturnType<typeof createMockImapClient>) {
  return {
    getAccount: vi.fn().mockReturnValue({
      name: 'test',
      email: 'test@example.com',
      username: 'test@example.com',
      imap: { host: 'imap.example.com', port: 993, tls: true, starttls: false, verifySsl: true },
      smtp: { host: 'smtp.example.com', port: 465, tls: true, starttls: false, verifySsl: true },
    }),
    getAccountNames: vi.fn().mockReturnValue(['test']),
    getImapClient: vi.fn().mockResolvedValue(mockClient),
    getSmtpTransport: vi.fn(),
    closeAll: vi.fn(),
  } satisfies IConnectionManager;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ImapService', () => {
  let client: ReturnType<typeof createMockImapClient>;
  let connections: ReturnType<typeof createMockConnectionManager>;
  let service: ImapService;

  beforeEach(() => {
    client = createMockImapClient();
    connections = createMockConnectionManager(client);
    service = new ImapService(connections);
  });

  afterEach(() => {
    service.dispose();
  });

  /** A ImapFlow download() result whose stream yields `text`. */
  function downloadYielding(text: string) {
    return {
      content: (async function* gen() {
        yield Buffer.from(text, 'utf-8');
      })(),
    };
  }

  // -----------------------------------------------------------------------
  // listMailboxes
  // -----------------------------------------------------------------------

  describe('label strategy detection', () => {
    it('retries after a failed detection instead of caching the rejection', async () => {
      // Detection is deduplicated via a pending-promise map. If the entry is
      // only cleared on success, the rejected promise is handed to every later
      // caller, so one transient IMAP hiccup breaks every label operation for
      // that account until the process restarts.
      client.list.mockRejectedValueOnce(new Error('connection reset'));

      await expect(service.listLabels('test')).rejects.toThrow('connection reset');

      client.list.mockResolvedValue([{ name: 'INBOX', path: 'INBOX', flags: new Set() }]);
      await expect(service.listLabels('test')).resolves.toBeInstanceOf(Array);
    });

    it('still deduplicates concurrent detection for the same account', async () => {
      client.list.mockResolvedValue([{ name: 'INBOX', path: 'INBOX', flags: new Set() }]);

      await Promise.all([service.listLabels('test'), service.listLabels('test')]);

      // One detection pass, not one per caller.
      expect(client.list).toHaveBeenCalledTimes(1);
    });
  });

  describe('listMailboxes', () => {
    it('returns mailbox list with message counts', async () => {
      client.list.mockResolvedValue([
        { name: 'INBOX', path: 'INBOX', specialUse: '\\Inbox' },
        { name: 'Sent', path: 'Sent', specialUse: '\\Sent' },
      ]);
      client.status.mockResolvedValue({ messages: 10, unseen: 3 });

      const result = await service.listMailboxes('test');

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        name: 'INBOX',
        path: 'INBOX',
        specialUse: '\\Inbox',
        totalMessages: 10,
        unseenMessages: 3,
      });
      expect(result[1]).toEqual({
        name: 'Sent',
        path: 'Sent',
        specialUse: '\\Sent',
        totalMessages: 10,
        unseenMessages: 3,
      });
      expect(client.status).toHaveBeenCalledTimes(2);
    });

    it('reports unknown counts when STATUS fails instead of zero', async () => {
      client.list.mockResolvedValue([
        { name: 'INBOX', path: 'INBOX', specialUse: '\\Inbox' },
        { name: 'Broken', path: 'Broken', specialUse: undefined },
      ]);
      client.status.mockImplementation(async (path: string) => {
        if (path === 'Broken') throw new Error('STATUS failed: connection reset');
        return { messages: 10, unseen: 3 };
      });

      const result = await service.listMailboxes('test');

      expect(result[0]).toMatchObject({ totalMessages: 10, unseenMessages: 3 });
      // A transient STATUS failure must stay distinguishable from a genuinely
      // empty mailbox — reporting 0 here would be cached as fact.
      expect(result[1]!.totalMessages).toBeUndefined();
      expect(result[1]!.unseenMessages).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // listEmails
  // -----------------------------------------------------------------------

  describe('listEmails', () => {
    it('fetches only the requested sequence window in an unfiltered large mailbox', async () => {
      Object.assign(client, { mailbox: { exists: 100000 } });
      client.fetch.mockReturnValueOnce(
        (async function* () {
          yield { uid: 99991 };
          yield { uid: 99992 };
        })(),
      );
      const result = await service.listEmails('test', { page: 50000, pageSize: 2 });
      expect(client.search).not.toHaveBeenCalled();
      expect(client.fetch).toHaveBeenNthCalledWith(1, '1:2', { uid: true });
      expect(client.fetch.mock.calls[1]?.[0]).toBe('99992,99991');
      expect(result).toMatchObject({ total: 100000, page: 50000, hasMore: false });
    });

    it.each([0, 5])(
      'does not fetch a reversed range for an empty or past-end page (%i)',
      async (exists) => {
        Object.assign(client, { mailbox: { exists } });
        const result = await service.listEmails('test', { page: 2, pageSize: 20 });
        expect(client.fetch).not.toHaveBeenCalled();
        expect(client.search).not.toHaveBeenCalled();
        expect(result).toMatchObject({ items: [], total: exists, hasMore: false });
      },
    );

    it('retains server-side filtering when a mailbox snapshot is available', async () => {
      Object.assign(client, { mailbox: { exists: 100000 } });
      await service.listEmails('test', { seen: false });
      expect(client.search).toHaveBeenCalledWith({ seen: false }, { uid: true });
    });
    function fetchYielding(...messages: Record<string, unknown>[]) {
      return () =>
        (async function* gen() {
          for (const m of messages) yield m;
        })();
    }

    it('uses the UID as the email id', async () => {
      client.search.mockResolvedValue([77]);
      client.fetch.mockImplementation(
        fetchYielding({ uid: 77, seq: 3, envelope: { subject: 'Hi' }, flags: [] }),
      );

      const result = await service.listEmails('test', { mailbox: 'INBOX' });

      expect(result.items[0]!.id).toBe('77');
    });

    it('does not fetch message source for listings', async () => {
      // The 256-byte source window never reached past real header blocks, so
      // the preview it fed was always undefined — pure bandwidth waste on
      // every list and search.
      client.search.mockResolvedValue([77]);
      client.fetch.mockImplementation(
        fetchYielding({ uid: 77, envelope: { subject: 'Hi' }, flags: [] }),
      );

      await service.listEmails('test', { mailbox: 'INBOX' });

      const [, query] = client.fetch.mock.calls[0]!;
      expect(query.source).toBeUndefined();
    });

    it('requests the bulk-classification header fields and marks a newsletter', async () => {
      client.search.mockResolvedValue([77]);
      client.fetch.mockImplementation(
        fetchYielding({
          uid: 77,
          envelope: { subject: 'Weekly digest' },
          flags: [],
          headers: Buffer.from('List-Unsubscribe: <https://example.com/u/abc>\r\n\r\n'),
        }),
      );

      const result = await service.listEmails('test', { mailbox: 'INBOX' });

      const [, query] = client.fetch.mock.calls[0]!;
      expect(query.headers).toEqual([
        'list-unsubscribe',
        'list-unsubscribe-post',
        'list-id',
        'precedence',
        'auto-submitted',
      ]);
      expect(result.items[0]!.bulk).toMatchObject({ kind: 'newsletter' });
    });

    it('leaves bulk undefined for personal mail', async () => {
      client.search.mockResolvedValue([77]);
      client.fetch.mockImplementation(
        fetchYielding({
          uid: 77,
          envelope: { subject: 'Lunch?' },
          flags: [],
          headers: Buffer.from('\r\n'),
        }),
      );

      const result = await service.listEmails('test', { mailbox: 'INBOX' });

      expect(result.items[0]!.bulk).toBeUndefined();
    });

    it('does not request bodyParts when preview is not requested', async () => {
      client.search.mockResolvedValue([77]);
      client.fetch.mockImplementation(
        fetchYielding({ uid: 77, envelope: { subject: 'Hi' }, flags: [] }),
      );

      await service.listEmails('test', { mailbox: 'INBOX' });

      const [, query] = client.fetch.mock.calls[0]!;
      expect(query.bodyParts).toBeUndefined();
    });

    it('decodes a body preview when requested, for a simple single-part message', async () => {
      client.search.mockResolvedValue([77]);
      client.fetch.mockImplementation(
        fetchYielding({
          uid: 77,
          envelope: { subject: 'Hi' },
          flags: [],
          bodyStructure: { type: 'text/plain', encoding: '8bit', parameters: { charset: 'utf-8' } },
          bodyParts: new Map([['1', Buffer.from('The actual message body text.')]]),
        }),
      );

      const result = await service.listEmails('test', { mailbox: 'INBOX', preview: true });

      const [, query] = client.fetch.mock.calls[0]!;
      expect(query.bodyParts).toEqual([{ key: '1', start: 0, maxLength: 1500 }]);
      expect(result.items[0]!.preview).toBe('The actual message body text.');
    });

    // Roughly 4% of real messages: section 1 is itself a multipart, so the
    // text sits at 1.1 — which needs its own fetch, since asking for a
    // section a message does not have fails the whole batch on Gmail.
    it('fetches the nested 1.1 part in a second pass when section 1 is itself a multipart', async () => {
      client.search.mockResolvedValue([77]);
      const nestedStructure = {
        type: 'multipart/alternative',
        childNodes: [
          { part: '1.1', type: 'text/plain', encoding: '8bit', parameters: { charset: 'utf-8' } },
          { part: '1.2', type: 'text/html' },
        ],
      };
      let callCount = 0;
      client.fetch.mockImplementation(() => {
        callCount += 1;
        if (callCount === 1) {
          return (async function* firstPass() {
            yield {
              uid: 77,
              envelope: { subject: 'Hi' },
              flags: [],
              bodyStructure: nestedStructure,
            };
          })();
        }
        return (async function* secondPass() {
          yield { uid: 77, bodyParts: new Map([['1.1', Buffer.from('Nested plain text body.')]]) };
        })();
      });

      const result = await service.listEmails('test', { mailbox: 'INBOX', preview: true });

      expect(client.fetch).toHaveBeenCalledTimes(2);
      const [, secondQuery] = client.fetch.mock.calls[1]!;
      expect(secondQuery.bodyParts).toEqual([{ key: '1.1', start: 0, maxLength: 1500 }]);
      expect(result.items[0]!.preview).toBe('Nested plain text body.');
    });

    it('rejects a message with no UID rather than falling back to its sequence number', async () => {
      client.search.mockResolvedValue([5]);
      // A server that answers a UID FETCH without a UID is violating the
      // protocol. Treating seq 3 as UID 3 would make every later write —
      // setFlags, moveEmail, deleteEmail — target the wrong message.
      client.fetch.mockImplementation(
        fetchYielding({ seq: 3, envelope: { subject: 'No uid' }, flags: [] }),
      );

      await expect(service.listEmails('test', { mailbox: 'INBOX' })).rejects.toThrow(/UID/i);
    });
  });

  describe('searchEmails cache supplement', () => {
    function fetchYielding(...messages: Record<string, unknown>[]) {
      return () =>
        (async function* gen() {
          for (const m of messages) yield m;
        })();
    }

    function stubMailbox() {
      (client as unknown as { mailbox: { uidValidity: bigint } }).mailbox = {
        uidValidity: 100n,
      };
    }

    it('unions cached FTS hits (attachment filenames) into live results', async () => {
      stubMailbox();
      client.search.mockResolvedValue([5]);
      client.fetch.mockImplementation(
        fetchYielding(
          { uid: 9, envelope: { subject: 'Q3 report attached' }, flags: [] },
          { uid: 5, envelope: { subject: 'report discussion' }, flags: [] },
        ),
      );
      const cacheStub = { searchMessages: vi.fn().mockReturnValue([{ uid: 9 }, { uid: 5 }]) };
      service.setCacheStore(cacheStub as never);

      const result = await service.searchEmails('test', 'report', {});

      expect(cacheStub.searchMessages).toHaveBeenCalledWith('test', 'INBOX', '100', 'report');
      expect(result.total).toBe(2);
    });

    it('leaves the cache out when structured filters are active', async () => {
      stubMailbox();
      client.search.mockResolvedValue([]);
      const cacheStub = { searchMessages: vi.fn().mockReturnValue([{ uid: 9 }]) };
      service.setCacheStore(cacheStub as never);

      await service.searchEmails('test', 'report', { to: 'someone@example.com' });

      expect(cacheStub.searchMessages).not.toHaveBeenCalled();
    });

    it('leaves the cache out when a date filter is active', async () => {
      stubMailbox();
      client.search.mockResolvedValue([]);
      const cacheStub = { searchMessages: vi.fn().mockReturnValue([{ uid: 9 }]) };
      service.setCacheStore(cacheStub as never);

      await service.searchEmails('test', 'report', { since: '2026-05-01T00:00:00Z' });

      expect(cacheStub.searchMessages).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // searchEmails — criteria builder
  // -----------------------------------------------------------------------

  describe('searchEmails filters', () => {
    it('throws when no query and no filters are provided', async () => {
      await expect(service.searchEmails('test', '')).rejects.toThrow(
        /at least one of: query, from, to/,
      );
      expect(client.search).not.toHaveBeenCalled();
    });

    it('AND-combines from with the OR keyword criteria', async () => {
      client.search.mockResolvedValue([]);

      await service.searchEmails('test', 'invoice', { from: 'billing@example.com' });

      const [criteria] = client.search.mock.calls[0]!;
      expect(criteria).toMatchObject({
        or: [{ subject: 'invoice' }, { from: 'invoice' }, { body: 'invoice' }],
        from: 'billing@example.com',
      });
    });

    it('passes since/before/sentSince/sentBefore as Date objects', async () => {
      client.search.mockResolvedValue([]);

      await service.searchEmails('test', '', {
        from: 'billing@example.com',
        since: '2026-05-01T00:00:00Z',
        before: '2026-05-08T00:00:00Z',
        sentSince: '2026-05-01T00:00:00Z',
        sentBefore: '2026-05-08T00:00:00Z',
      });

      const [criteria] = client.search.mock.calls[0]! as [Record<string, unknown>];
      expect(criteria.since).toBeInstanceOf(Date);
      expect(criteria.before).toBeInstanceOf(Date);
      expect(criteria.sentSince).toBeInstanceOf(Date);
      expect(criteria.sentBefore).toBeInstanceOf(Date);
      expect((criteria.since as Date).toISOString()).toBe('2026-05-01T00:00:00.000Z');
      expect((criteria.before as Date).toISOString()).toBe('2026-05-08T00:00:00.000Z');
    });

    it('allows a search with only a filter and no keyword', async () => {
      client.search.mockResolvedValue([]);

      await expect(
        service.searchEmails('test', '', { since: '2026-05-01T00:00:00Z' }),
      ).resolves.toMatchObject({ items: [], total: 0 });
      expect(client.search).toHaveBeenCalledTimes(1);
    });
  });

  // -----------------------------------------------------------------------
  // getEmail — body part selection
  // -----------------------------------------------------------------------

  describe('getEmail', () => {
    /**
     * multipart/mixed → [1] multipart/alternative → [1.1 text/plain, 1.2 text/html], [2] attachment
     *
     * Shapes here mirror ImapFlow's MessageStructureObject exactly: `type` is
     * the full Content-Type and there is no `subtype` field (imap-flow.d.ts:504).
     */
    const nestedStructure = {
      type: 'multipart/mixed',
      childNodes: [
        {
          part: '1',
          type: 'multipart/alternative',
          childNodes: [
            { part: '1.1', type: 'text/plain', size: 120 },
            { part: '1.2', type: 'text/html', size: 400 },
          ],
        },
        {
          part: '2',
          type: 'application/pdf',
          disposition: 'attachment',
          dispositionParameters: { filename: 'invoice.pdf' },
          size: 9000,
        },
      ],
    };

    beforeEach(() => {
      client.fetchOne = vi.fn().mockResolvedValue({
        uid: 42,
        envelope: { subject: 'Nested', messageId: '<a@b>' },
        flags: [],
        bodyStructure: nestedStructure,
        source: Buffer.from('Subject: Nested\r\n\r\nfallback body\r\n', 'utf-8'),
      });
      client.download = vi.fn();
    });

    it('classifies bulk mail from the full header set', async () => {
      client.fetchOne.mockResolvedValue({
        uid: 42,
        envelope: { subject: 'Nested', messageId: '<a@b>' },
        flags: [],
        bodyStructure: nestedStructure,
        source: Buffer.from('Subject: Nested\r\n\r\nfallback body\r\n', 'utf-8'),
        headers: Buffer.from('Precedence: bulk\r\n\r\n'),
      });
      client.download.mockResolvedValue(downloadYielding('x'));

      const email = await service.getEmail('test', '42', 'INBOX');

      expect(email.bulk).toMatchObject({ kind: 'automated' });
    });

    it('downloads the real text/plain part, not hardcoded part "1"', async () => {
      client.download.mockResolvedValue(downloadYielding('the actual plain text'));

      const email = await service.getEmail('test', '42', 'INBOX');

      // Part "1" here is the multipart/alternative container. Downloading it
      // returns raw MIME with boundary markers, not a readable body.
      expect(client.download).toHaveBeenCalledWith('42', '1.1', { uid: true });
      expect(email.bodyText).toBe('the actual plain text');
    });

    it('never returns raw MIME as bodyText for an html-only multipart message', async () => {
      // Real shape seen end-to-end: multipart/mixed → multipart/related →
      // text/html, with no text/plain part anywhere.
      const htmlOnly = {
        type: 'multipart/mixed',
        childNodes: [
          {
            part: '1',
            type: 'multipart/related',
            childNodes: [{ part: '1.1', type: 'text/html', size: 900 }],
          },
        ],
      };
      const rawSource = [
        'Subject: Lieferung unterwegs',
        'Content-Type: multipart/mixed; boundary=b4d4d798',
        '',
        '--b4d4d798',
        'Content-Type: text/html; charset=utf-8',
        '',
        '<html><body><p>Ihre Sendung ist unterwegs.</p></body></html>',
        '--b4d4d798--',
      ].join('\r\n');

      client.fetchOne.mockResolvedValue({
        uid: 42,
        envelope: { subject: 'Lieferung unterwegs', messageId: '<a@b>' },
        flags: [],
        bodyStructure: htmlOnly,
        source: Buffer.from(rawSource, 'utf-8'),
      });
      client.download.mockResolvedValue(
        downloadYielding('<html><body><p>Ihre Sendung ist unterwegs.</p></body></html>'),
      );

      const email = await service.getEmail('test', '42', 'INBOX');

      // The source-parsed "body" of a multipart message is boundary markers and
      // part headers. Returning it as bodyText hides the real content, because
      // the tool layer prefers bodyText over stripping bodyHtml.
      expect(email.bodyText ?? '').not.toContain('--b4d4d798');
      expect(email.bodyText ?? '').not.toContain('Content-Type:');
      expect(email.bodyHtml).toContain('Ihre Sendung ist unterwegs.');
    });

    it('downloads the body of a single-part message rather than reading raw source', async () => {
      // 165 of 169 messages in a real mailbox look like this: no multipart, no
      // `part` field. Reading the body out of `source` returns it still
      // transfer-encoded — "=3D" for '=', soft breaks splitting words — because
      // source is raw RFC822. download() applies the decoding.
      client.fetchOne.mockResolvedValue({
        uid: 42,
        envelope: { subject: 'Newsletter', messageId: '<a@b>' },
        flags: [],
        bodyStructure: { type: 'text/html', encoding: 'quoted-printable', size: 5136 },
        headers: Buffer.from(
          'Subject: Newsletter\r\nContent-Type: text/html; charset=utf-8\r\n' +
            'Content-Transfer-Encoding: quoted-printable\r\n\r\n',
          'utf-8',
        ),
      });
      client.download.mockResolvedValue(downloadYielding('<html lang="en">We’re here</html>'));

      const email = await service.getEmail('test', '42', 'INBOX');

      expect(client.download).toHaveBeenCalledWith('42', '1', { uid: true });
      expect(email.bodyHtml).toContain('lang="en"');
      expect(email.bodyHtml ?? '').not.toContain('=3D');
    });

    it('parses headers without downloading the whole message', async () => {
      client.fetchOne.mockResolvedValue({
        uid: 42,
        envelope: { subject: 'Newsletter', messageId: '<a@b>' },
        flags: [],
        bodyStructure: { type: 'text/plain', size: 20 },
        headers: Buffer.from(
          'Subject: Newsletter\r\nReferences: <x@y> <z@w>\r\nContent-Type: text/plain\r\n\r\n',
          'utf-8',
        ),
      });
      client.download.mockResolvedValue(downloadYielding('body text'));

      const email = await service.getEmail('test', '42', 'INBOX');

      expect(email.headers.subject).toBe('Newsletter');
      expect(email.references).toEqual(['<x@y>', '<z@w>']);

      // `source: true` pulls the entire message — base64 attachments included —
      // just to read headers that HEADER alone would supply.
      const [, query] = client.fetchOne.mock.calls[0]!;
      expect(query.source).toBeUndefined();
      expect(query.headers).toBe(true);
    });

    it('prefers the html part when the plain part is a stub', async () => {
      client.fetchOne.mockResolvedValue({
        uid: 42,
        envelope: { subject: 'Stub', messageId: '<a@b>' },
        flags: [],
        bodyStructure: {
          type: 'multipart/alternative',
          childNodes: [
            // "This message requires HTML" — a placeholder, not the content.
            { part: '1', type: 'text/plain', size: 48 },
            { part: '2', type: 'text/html', size: 9000 },
          ],
        },
        headers: Buffer.from('Subject: Stub\r\n\r\n', 'utf-8'),
      });
      client.download.mockResolvedValue(downloadYielding('<html>real content</html>'));

      await service.getEmail('test', '42', 'INBOX');

      expect(client.download).toHaveBeenCalledWith('42', '2', { uid: true });
    });

    it('keeps the plain part when it is substantive', async () => {
      client.fetchOne.mockResolvedValue({
        uid: 42,
        envelope: { subject: 'Real', messageId: '<a@b>' },
        flags: [],
        bodyStructure: {
          type: 'multipart/alternative',
          childNodes: [
            { part: '1', type: 'text/plain', size: 4000 },
            { part: '2', type: 'text/html', size: 9000 },
          ],
        },
        headers: Buffer.from('Subject: Real\r\n\r\n', 'utf-8'),
      });
      client.download.mockResolvedValue(downloadYielding('the plain body'));

      await service.getEmail('test', '42', 'INBOX');

      // Plain text is far cheaper in context-window terms, which the
      // performance roadmap calls the real constraint.
      expect(client.download).toHaveBeenCalledWith('42', '1', { uid: true });
    });

    it('downloads both the plain and html parts of multipart/alternative', async () => {
      client.fetchOne.mockResolvedValue({
        uid: 42,
        envelope: { subject: 'Alt', messageId: '<a@b>' },
        flags: [],
        bodyStructure: {
          type: 'multipart/alternative',
          childNodes: [
            { part: '1', type: 'text/plain', size: 4000 },
            { part: '2', type: 'text/html', size: 9000 },
          ],
        },
        headers: Buffer.from('Subject: Alt\r\n\r\n', 'utf-8'),
      });
      client.download.mockImplementation(async (_uid: string, path: string) =>
        downloadYielding(path === '1' ? 'plain body' : '<p>html body</p>'),
      );

      const email = await service.getEmail('test', '42', 'INBOX');

      // Both halves populate so format="full", magic-link extraction, and
      // calendar scanning can use whichever side they need.
      expect(email.bodyText).toBe('plain body');
      expect(email.bodyHtml).toBe('<p>html body</p>');
    });

    it('unwraps a format=flowed plain body', async () => {
      client.fetchOne.mockResolvedValue({
        uid: 42,
        envelope: { subject: 'Flowed', messageId: '<a@b>' },
        flags: [],
        bodyStructure: {
          type: 'text/plain',
          size: 120,
          parameters: { charset: 'utf-8', format: 'flowed' },
        },
        headers: Buffer.from('Subject: Flowed\r\n\r\n', 'utf-8'),
      });
      client.download.mockResolvedValue(
        downloadYielding('the sender wrapped this \nat the margin.\n\nNew paragraph.'),
      );

      const email = await service.getEmail('test', '42', 'INBOX');

      expect(email.bodyText).toBe('the sender wrapped this at the margin.\n\nNew paragraph.');
    });

    it('concatenates sibling text parts so text after an inline image survives', async () => {
      client.fetchOne.mockResolvedValue({
        uid: 42,
        envelope: { subject: 'Photo', messageId: '<a@b>' },
        flags: [],
        bodyStructure: {
          type: 'multipart/mixed',
          childNodes: [
            { part: '1', type: 'text/plain', size: 40 },
            {
              part: '2',
              type: 'image/jpeg',
              size: 90_000,
              disposition: 'inline',
              parameters: { name: 'p.jpg' },
            },
            { part: '3', type: 'text/plain', size: 120 },
          ],
        },
        headers: Buffer.from('Subject: Photo\r\n\r\n', 'utf-8'),
      });
      client.download.mockImplementation(async (_uid: string, path: string) =>
        downloadYielding(path === '1' ? 'Here it is:' : 'Taken last week.'),
      );

      const email = await service.getEmail('test', '42', 'INBOX');

      expect(email.bodyText).toBe('Here it is:\n\nTaken last week.');
      expect(client.download).toHaveBeenCalledTimes(2);
    });

    it('skips an oversized part when a sibling within the cap exists', async () => {
      client.fetchOne.mockResolvedValue({
        uid: 42,
        envelope: { subject: 'Big', messageId: '<a@b>' },
        flags: [],
        bodyStructure: {
          type: 'multipart/alternative',
          childNodes: [
            { part: '1', type: 'text/plain', size: 400 },
            { part: '2', type: 'text/html', size: 10 * 1024 * 1024 },
          ],
        },
        headers: Buffer.from('Subject: Big\r\n\r\n', 'utf-8'),
      });
      client.download.mockResolvedValue(downloadYielding('small plain'));

      const email = await service.getEmail('test', '42', 'INBOX');

      expect(email.bodyText).toBe('small plain');
      expect(email.bodyHtml).toBeUndefined();
      expect(client.download).toHaveBeenCalledTimes(1);
      expect(client.download).toHaveBeenCalledWith('42', '1', { uid: true });
    });

    it('truncates a sole over-cap body instead of returning it whole', async () => {
      client.fetchOne.mockResolvedValue({
        uid: 42,
        envelope: { subject: 'Huge', messageId: '<a@b>' },
        flags: [],
        bodyStructure: { type: 'text/html', size: 10 * 1024 * 1024 },
        headers: Buffer.from('Subject: Huge\r\n\r\n', 'utf-8'),
      });
      const big = 'a'.repeat(600 * 1024);
      client.download.mockResolvedValue(downloadYielding(big));

      const email = await service.getEmail('test', '42', 'INBOX');

      // The stream is drained but only the first 512 KB is kept; destroying
      // an ImapFlow download stream mid-command corrupts connection state.
      expect(email.bodyHtml?.length).toBeLessThan(big.length);
      expect(email.bodyHtml).toContain('truncated');
    });

    it('keeps the human-readable part of an HTML bounce alongside the status', async () => {
      // Appending the status into bodyText when the explanation is HTML makes
      // applyBodyFormat prefer the status block and never show the reason.
      client.fetchOne.mockResolvedValue({
        uid: 42,
        envelope: { subject: 'Undelivered', messageId: '<a@b>' },
        flags: [],
        bodyStructure: {
          type: 'multipart/report',
          childNodes: [
            { part: '1', type: 'text/html', size: 300 },
            { part: '2', type: 'message/delivery-status', size: 200 },
          ],
        },
        headers: Buffer.from('Subject: Undelivered\r\n\r\n', 'utf-8'),
      });
      client.download.mockImplementation(async (_uid: string, path: string) =>
        downloadYielding(
          path === '2' ? 'Action: failed\nStatus: 5.1.1' : '<p>Your message bounced.</p>',
        ),
      );

      const email = await service.getEmail('test', '42', 'INBOX');

      expect(email.bodyHtml).toContain('Your message bounced.');
      expect(email.bodyText).toBeUndefined();
      expect(email.deliveryStatus).toContain('Status: 5.1.1');
    });

    it('downloads only one body part when both exceed the cap', async () => {
      client.fetchOne.mockResolvedValue({
        uid: 42,
        envelope: { subject: 'BothBig', messageId: '<a@b>' },
        flags: [],
        bodyStructure: {
          type: 'multipart/alternative',
          childNodes: [
            { part: '1', type: 'text/plain', size: 700 * 1024 },
            { part: '2', type: 'text/html', size: 900 * 1024 },
          ],
        },
        headers: Buffer.from('Subject: BothBig\r\n\r\n', 'utf-8'),
      });
      client.download.mockResolvedValue(downloadYielding('x'.repeat(1000)));

      await service.getEmail('test', '42', 'INBOX');

      // Fetching 1.6 MB to truncate both halves to 512 KB is pure waste; one
      // readable body is the point of the cap.
      expect(client.download).toHaveBeenCalledTimes(1);
      expect(client.download).toHaveBeenCalledWith('42', '1', { uid: true });
    });

    it('does not split a multibyte character at the truncation boundary', async () => {
      const cap = 512 * 1024;
      client.fetchOne.mockResolvedValue({
        uid: 42,
        envelope: { subject: 'Multibyte', messageId: '<a@b>' },
        flags: [],
        bodyStructure: { type: 'text/plain', size: 10 * 1024 * 1024 },
        headers: Buffer.from('Subject: Multibyte\r\n\r\n', 'utf-8'),
      });
      // 'ä' is two bytes, so the 512 KB boundary lands mid-character.
      client.download.mockResolvedValue({
        content: (async function* gen() {
          yield Buffer.from('a'.repeat(cap - 1) + 'ä'.repeat(100), 'utf-8');
        })(),
      });

      const email = await service.getEmail('test', '42', 'INBOX');

      expect(email.bodyText).toContain('truncated');
      expect(email.bodyText).not.toContain('�');
    });

    it('converts a non-UTF-8 text body using its declared charset', async () => {
      // ImapFlow charset-converts text/plain and text/html only, so any other
      // text subtype arrives as raw bytes with the charset in meta.
      client.fetchOne.mockResolvedValue({
        uid: 42,
        envelope: { subject: 'Enriched', messageId: '<a@b>' },
        flags: [],
        bodyStructure: { type: 'text/enriched', size: 50 },
        headers: Buffer.from('Subject: Enriched\r\n\r\n', 'utf-8'),
      });
      client.download.mockResolvedValue({
        meta: { charset: 'iso-8859-1' },
        content: (async function* gen() {
          yield Buffer.from('Grüße aus München', 'latin1');
        })(),
      });

      const email = await service.getEmail('test', '42', 'INBOX');

      expect(email.bodyText).toBe('Grüße aus München');
    });

    it('labels an S/MIME message instead of returning no content', async () => {
      client.fetchOne.mockResolvedValue({
        uid: 42,
        envelope: { subject: 'Signed', messageId: '<a@b>' },
        flags: [],
        bodyStructure: {
          type: 'application/pkcs7-mime',
          size: 5000,
          disposition: 'attachment',
          dispositionParameters: { filename: 'smime.p7m' },
        },
        headers: Buffer.from('Subject: Signed\r\n\r\n', 'utf-8'),
      });

      const email = await service.getEmail('test', '42', 'INBOX');

      expect(email.bodyText).toMatch(/S\/MIME/);
      expect(client.download).not.toHaveBeenCalled();
    });

    it('appends the delivery status of a bounce report to the body', async () => {
      client.fetchOne.mockResolvedValue({
        uid: 42,
        envelope: { subject: 'Undelivered', messageId: '<a@b>' },
        flags: [],
        bodyStructure: {
          type: 'multipart/report',
          childNodes: [
            { part: '1', type: 'text/plain', size: 300 },
            { part: '2', type: 'message/delivery-status', size: 200 },
          ],
        },
        headers: Buffer.from('Subject: Undelivered\r\n\r\n', 'utf-8'),
      });
      client.download.mockImplementation(async (_uid: string, path: string) =>
        downloadYielding(
          path === '2' ? 'Action: failed\nStatus: 5.1.1' : 'Delivery failed message',
        ),
      );

      const email = await service.getEmail('test', '42', 'INBOX');

      // The machine-readable part is where the actual status code lives; a
      // bounce without it reads like an ordinary email. It rides in its own
      // field so it can never displace the human-readable explanation.
      expect(email.bodyText).toContain('Delivery failed message');
      expect(email.bodyText).not.toContain('Status: 5.1.1');
      expect(email.deliveryStatus).toContain('Action: failed');
      expect(email.deliveryStatus).toContain('Status: 5.1.1');
    });

    it('reports a well-formed attachment mimeType', async () => {
      client.download.mockResolvedValue(downloadYielding('body'));

      const email = await service.getEmail('test', '42', 'INBOX');

      // ImapFlow's `type` is already the full Content-Type, so appending a
      // non-existent `subtype` yields "application/pdf/octet-stream".
      expect(email.attachments[0]!.mimeType).toBe('application/pdf');
    });

    it('returns an empty body rather than throwing when the part is missing', async () => {
      client.fetchOne.mockResolvedValue({
        uid: 42,
        envelope: { subject: 'Simple', messageId: '<a@b>' },
        flags: [],
        bodyStructure: { type: 'text/plain', size: 20 },
        headers: Buffer.from('Subject: Simple\r\nContent-Type: text/plain\r\n\r\n', 'utf-8'),
      });
      client.download.mockRejectedValue(new Error('NO such part'));
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

      const email = await service.getEmail('test', '42', 'INBOX');

      // Headers and metadata are still useful even when the server refuses
      // the body part, so this degrades rather than failing the whole call —
      // but no longer silently: the failure is noted on stderr.
      expect(email.subject).toBe('Simple');
      expect(email.bodyText).toBeUndefined();
      expect(stderr).toHaveBeenCalled();
      stderr.mockRestore();
    });

    it('unfolds headers split across continuation lines', async () => {
      client.fetchOne.mockResolvedValue({
        uid: 42,
        envelope: { subject: 'Folded', messageId: '<a@b>' },
        flags: [],
        bodyStructure: { type: 'text/plain', size: 20 },
        // RFC 5322 allows long headers to wrap onto indented lines; treating
        // the continuation as a new header loses half the value.
        headers: Buffer.from(
          'Subject: Folded\r\nReferences: <one@x>\r\n <two@x>\r\n\t<three@x>\r\n\r\n',
          'utf-8',
        ),
      });
      client.download.mockResolvedValue(downloadYielding('body'));

      const email = await service.getEmail('test', '42', 'INBOX');

      expect(email.references).toEqual(['<one@x>', '<two@x>', '<three@x>']);
    });
  });

  // -----------------------------------------------------------------------
  // Mailbox name sanitization
  // -----------------------------------------------------------------------

  describe('mailbox sanitization', () => {
    // Every method taking a mailbox path must run it through
    // sanitizeMailboxName: it rejects the IMAP wildcards * and %, and trims —
    // which also keeps " INBOX " and "INBOX" from becoming two cache keys.
    const cases: [string, () => Promise<unknown>][] = [
      ['getEmailFlags', () => service.getEmailFlags('test', '1', 'IN*OX')],
      ['bulkSetFlags', () => service.bulkSetFlags('test', [1], 'IN*OX', 'mark_read')],
      ['bulkMove', () => service.bulkMove('test', [1], 'IN*OX', 'Archive')],
      ['bulkDelete', () => service.bulkDelete('test', [1], 'IN*OX', true)],
      ['getThread', () => service.getThread('test', '<a@b>', 'IN*OX')],
      ['extractContacts', () => service.extractContacts('test', { mailbox: 'IN*OX' })],
      ['getEmailStats', () => service.getEmailStats('test', 'IN*OX', 'day')],
      ['getCalendarParts', () => service.getCalendarParts('test', 'IN*OX', '1')],
      ['downloadAttachment', () => service.downloadAttachment('test', '1', 'IN*OX', 'f.pdf')],
      ['findEmailFolder', () => service.findEmailFolder('test', '1', 'IN*OX')],
    ];

    it.each(cases)('%s rejects IMAP wildcards in the mailbox path', async (_name, invoke) => {
      await expect(invoke()).rejects.toThrow(/wildcard/i);
    });

    it('trims surrounding whitespace before locking the mailbox', async () => {
      await service.getEmailFlags('test', '1', '  INBOX  ').catch(() => {});
      expect(client.getMailboxLock).toHaveBeenCalledWith('INBOX');
    });
  });

  // -----------------------------------------------------------------------
  // saveEmailAttachments
  // -----------------------------------------------------------------------

  describe('saveEmailAttachments', () => {
    it('saves an inline file that carries a filename', async () => {
      // Apple Mail sends user-inserted photos as `inline; filename=...`;
      // skipping every inline part wrote nothing to disk for such a message.
      client.fetchOne.mockResolvedValue({
        uid: 42,
        bodyStructure: {
          type: 'multipart/related',
          childNodes: [
            { part: '1', type: 'text/html', size: 100 },
            {
              part: '2',
              type: 'image/jpeg',
              disposition: 'inline',
              id: '<photo@mail>',
              dispositionParameters: { filename: 'IMG_1234.jpg' },
              size: 9,
            },
          ],
        },
      });
      client.download.mockResolvedValue(downloadYielding('jpegbytes'));
      const dir = mkdtempSync(join(tmpdir(), 'att-save-'));

      const saved = await service.saveEmailAttachments('test', '42', 'INBOX', dir);

      expect(saved.map((s) => s.filename)).toEqual(['IMG_1234.jpg']);
      rmSync(dir, { recursive: true, force: true });
    });
  });

  // -----------------------------------------------------------------------
  // saveDraft
  // -----------------------------------------------------------------------

  describe('saveDraft', () => {
    it('writes In-Reply-To and a folded References header', async () => {
      client.list.mockResolvedValue([{ path: 'Drafts', specialUse: '\\Drafts' }]);

      await service.saveDraft('test', {
        to: ['a@b.c'],
        subject: 'Re: hi',
        body: 'draft body',
        inReplyTo: '<orig@x>',
        references: ['<root@x>', '<orig@x>'],
      });

      const [, raw] = client.append.mock.calls[0]!;
      const message = (raw as Buffer).toString('utf-8');
      expect(message).toContain('In-Reply-To: <orig@x>');
      // Folded onto continuation lines — valid RFC 5322 and never overlong.
      expect(message).toContain('References: <root@x>\r\n <orig@x>');
    });

    it('appends a sent copy to the \\Sent special-use folder, flagged seen', async () => {
      client.list.mockResolvedValue([
        { path: 'INBOX', specialUse: '\\Inbox' },
        { path: '[Gmail]/Sent Mail', specialUse: '\\Sent' },
      ]);

      const result = await service.appendToSent('test', Buffer.from('raw message'));

      expect(result).toEqual({ kind: 'filed', path: '[Gmail]/Sent Mail' });
      expect(client.append).toHaveBeenCalledWith('[Gmail]/Sent Mail', expect.any(Buffer), [
        '\\Seen',
      ]);
    });

    it('falls back to "Sent" when no folder advertises the special use', async () => {
      client.list.mockResolvedValue([{ path: 'INBOX', specialUse: '\\Inbox' }, { path: 'Sent' }]);

      const result = await service.appendToSent('test', Buffer.from('raw'));

      expect(result).toEqual({ kind: 'filed', path: 'Sent' });
      expect(client.mailboxCreate).not.toHaveBeenCalled();
    });

    // Not every server ships one — GreenMail does not — and APPEND to a
    // missing mailbox is rejected, which the caller swallows so a completed
    // send is never reported as failed. The copy would vanish without a word.
    it('creates the Sent folder when the server has none', async () => {
      client.list.mockResolvedValue([{ path: 'INBOX', specialUse: '\\Inbox' }]);

      const result = await service.appendToSent('test', Buffer.from('raw'));

      expect(client.mailboxCreate).toHaveBeenCalledWith('Sent');
      expect(result).toEqual({ kind: 'filed', path: 'Sent' });
      expect(client.append).toHaveBeenCalledWith('Sent', expect.any(Buffer), ['\\Seen']);
    });

    it('does not create anything when the special-use folder exists', async () => {
      client.list.mockResolvedValue([{ path: '[Gmail]/Sent Mail', specialUse: '\\Sent' }]);

      await service.appendToSent('test', Buffer.from('raw'));

      expect(client.mailboxCreate).not.toHaveBeenCalled();
    });

    it('refuses header values carrying a line break', async () => {
      client.list.mockResolvedValue([{ path: 'Drafts', specialUse: '\\Drafts' }]);

      // These land verbatim in a hand-assembled RFC 822 message, so a CRLF
      // would inject headers or end the header block early.
      await expect(
        service.saveDraft('test', {
          to: ['a@b.c'],
          subject: 'Hi',
          body: 'b',
          inReplyTo: '<x@y>\r\nBcc: attacker@evil.test',
        }),
      ).rejects.toThrow(/line break/i);

      await expect(
        service.saveDraft('test', {
          to: ['a@b.c'],
          subject: 'Hi',
          body: 'b',
          references: ['<ok@y>', '<x@y>\nX-Evil: 1'],
        }),
      ).rejects.toThrow(/line break/i);

      expect(client.append).not.toHaveBeenCalled();
    });

    /** The raw RFC 822 message handed to APPEND. */
    async function savedMessage(options: Parameters<ImapService['saveDraft']>[1]): Promise<string> {
      client.list.mockResolvedValue([{ path: 'Drafts', specialUse: '\\Drafts' }]);
      await service.saveDraft('test', options);
      const [, raw] = client.append.mock.calls[0]!;
      return (raw as Buffer).toString('utf-8');
    }

    // A header may only carry 7-bit ASCII; a subject with umlauts has to go
    // out as an RFC 2047 encoded word or the message is malformed.
    it('encodes a non-ASCII subject as an RFC 2047 word', async () => {
      const message = await savedMessage({
        to: ['a@b.c'],
        subject: 'Bestätigung für Ihre Anfrage',
        body: 'body',
      });

      expect(message).toContain('=?UTF-8?Q?');
      expect(message).not.toContain('Subject: Bestätigung');
    });

    it('leaves a plain ASCII subject unencoded', async () => {
      const message = await savedMessage({ to: ['a@b.c'], subject: 'Re: hi', body: 'body' });
      expect(message).toContain('Subject: Re: hi');
    });

    // Absent Content-Transfer-Encoding means 7bit per RFC 2045, so appending
    // raw UTF-8 declares one thing and ships another.
    it('declares a transfer encoding and round-trips an 8-bit body', async () => {
      const body = 'Grüße aus Zürich — 10 €';
      const message = await savedMessage({ to: ['a@b.c'], subject: 'Hi', body });

      expect(message).toContain('Content-Transfer-Encoding: base64');
      const payload = message.split('\r\n\r\n').slice(1).join('\r\n\r\n');
      expect(Buffer.from(payload, 'base64').toString('utf-8')).toBe(body);
    });

    // send_email emits multipart/alternative for HTML; a stored draft that is
    // HTML-only renders as markup in any other client that opens it.
    it('stores an HTML draft as multipart/alternative with a text fallback', async () => {
      const message = await savedMessage({
        to: ['a@b.c'],
        subject: 'Hi',
        body: '<p>Hello <b>there</b></p>',
        html: true,
      });

      expect(message).toContain('Content-Type: multipart/alternative; boundary=');
      expect(message).toContain('Content-Type: text/plain; charset=utf-8');
      expect(message).toContain('Content-Type: text/html; charset=utf-8');

      const boundary = /boundary="([^"]+)"/.exec(message)?.[1];
      expect(boundary).toBeDefined();
      const parts = message.split(`--${boundary}`);
      // Preamble, the two alternatives, and the closing delimiter.
      expect(parts).toHaveLength(4);
      expect(parts[3]).toContain('--');

      const decodePart = (part: string): string =>
        Buffer.from(part.split('\r\n\r\n').slice(1).join('\r\n\r\n').trim(), 'base64').toString(
          'utf-8',
        );
      expect(decodePart(parts[1]!)).toBe('Hello there');
      expect(decodePart(parts[2]!)).toBe('<p>Hello <b>there</b></p>');
    });

    it('keeps a plain-text draft single-part', async () => {
      const message = await savedMessage({ to: ['a@b.c'], subject: 'Hi', body: 'just text' });
      expect(message).toContain('Content-Type: text/plain; charset=utf-8');
      expect(message).not.toContain('multipart/alternative');
    });
  });

  // -----------------------------------------------------------------------
  // appendToSent: Gmail dedup, sentMailbox override, failure reporting
  //
  // Gmail files messages sent through its SMTP into Sent Mail itself, so
  // APPENDing on top of that would give the user every sent message twice.
  // -----------------------------------------------------------------------

  describe('appendToSent — Gmail dedup and overrides', () => {
    it('skips filing on a server that advertises X-GM-EXT-1', async () => {
      client.capabilities.add('X-GM-EXT-1');

      const result = await service.appendToSent('test', Buffer.from('raw'));

      expect(result).toEqual({ kind: 'skipped' });
      expect(client.append).not.toHaveBeenCalled();
      expect(client.list).not.toHaveBeenCalled();
    });

    it('files anyway when the account explicitly sets save_to_sent = true', async () => {
      client.capabilities.add('X-GM-EXT-1');
      connections.getAccount.mockReturnValue({
        name: 'test',
        saveToSent: true,
      });
      client.list.mockResolvedValue([{ path: 'Sent', specialUse: '\\Sent' }]);

      const result = await service.appendToSent('test', Buffer.from('raw'));

      expect(result).toEqual({ kind: 'filed', path: 'Sent' });
      expect(client.append).toHaveBeenCalledOnce();
    });

    it('skips filing when the account explicitly sets save_to_sent = false, even off Gmail', async () => {
      connections.getAccount.mockReturnValue({
        name: 'test',
        saveToSent: false,
      });

      const result = await service.appendToSent('test', Buffer.from('raw'));

      expect(result).toEqual({ kind: 'skipped' });
      expect(client.append).not.toHaveBeenCalled();
    });

    it("prefers the configured sentMailbox over the server's guess, with no folder lookup", async () => {
      connections.getAccount.mockReturnValue({
        name: 'test',
        sentMailbox: 'INBOX.Sent Messages',
      });

      const result = await service.appendToSent('test', Buffer.from('raw'));

      expect(result).toEqual({ kind: 'filed', path: 'INBOX.Sent Messages' });
      expect(client.append).toHaveBeenCalledWith('INBOX.Sent Messages', expect.any(Buffer), [
        '\\Seen',
      ]);
      expect(client.list).not.toHaveBeenCalled();
    });

    it('reports a failed APPEND instead of throwing, so a completed send never looks failed', async () => {
      client.list.mockResolvedValue([{ path: 'Sent', specialUse: '\\Sent' }]);
      client.append.mockRejectedValue(new Error('Over quota'));

      const result = await service.appendToSent('test', Buffer.from('raw'));

      expect(result).toEqual({ kind: 'failed', error: expect.stringContaining('Over quota') });
    });
  });

  // -----------------------------------------------------------------------
  // downloadAttachment
  // -----------------------------------------------------------------------

  describe('downloadAttachment', () => {
    it.each([undefined, 'base64'])(
      'rejects actual oversized bytes despite a small BODYSTRUCTURE size (%s)',
      async (encoding) => {
        client.fetchOne.mockResolvedValue({
          uid: 42,
          bodyStructure: {
            type: 'application/pdf',
            disposition: 'attachment',
            dispositionParameters: { filename: 'file.pdf' },
            size: 1,
            encoding,
          },
        });
        let drained = false;
        client.download.mockResolvedValue({
          meta: { encoding },
          content: (async function* () {
            yield Buffer.alloc(5, 255);
            yield Buffer.alloc(5, 255);
            drained = true;
          })(),
        });
        await expect(
          service.downloadAttachment('test', '42', 'INBOX', 'file.pdf', 4),
        ).rejects.toThrow(/exceeds/);
        expect(drained).toBe(true);
        expect(client._releaseFn).toHaveBeenCalled();
      },
    );

    it('allows base64 expansion at the decoded limit and rejects decoded overflow', async () => {
      client.fetchOne.mockResolvedValue({
        uid: 42,
        bodyStructure: {
          type: 'application/pdf',
          disposition: 'attachment',
          dispositionParameters: { filename: 'file.pdf' },
          size: 1,
          encoding: 'base64',
        },
      });
      client.download.mockResolvedValueOnce(downloadYielding('YWJjZA=='));
      const result = await service.downloadAttachment('test', '42', 'INBOX', 'file.pdf', 4);
      expect(result.size).toBe(4);
      client.download.mockResolvedValueOnce(downloadYielding('YWJjZGU='));
      await expect(
        service.downloadAttachment('test', '42', 'INBOX', 'file.pdf', 4),
      ).rejects.toThrow(/exceeds/);
    });
    it('downloads a specific duplicate-named attachment by part id', async () => {
      const invoice = {
        type: 'application/pdf',
        disposition: 'attachment',
        dispositionParameters: { filename: 'invoice.pdf' },
        size: 100,
      };
      client.fetchOne.mockResolvedValue({
        uid: 42,
        bodyStructure: {
          type: 'multipart/mixed',
          childNodes: [{ part: '1', type: 'text/plain', size: 50 }, invoice, { ...invoice }],
        },
      });
      client.download.mockResolvedValue(downloadYielding('second pdf'));

      const result = await service.downloadAttachment('test', '42', 'INBOX', { partId: '3' });

      expect(client.download).toHaveBeenCalledWith('42', '3', { uid: true });
      expect(result.filename).toBe('invoice.pdf');
    });

    it('judges the size cap by estimated decoded size for base64 parts', async () => {
      // BODYSTRUCTURE reports encoded octets: 6 MB of base64 decodes to
      // ~4.5 MB, inside the 5 MB default cap — rejecting it would refuse a
      // file the caller is allowed to receive.
      client.fetchOne.mockResolvedValue({
        uid: 42,
        bodyStructure: {
          type: 'multipart/mixed',
          childNodes: [
            { part: '1', type: 'text/plain', size: 50 },
            {
              part: '2',
              type: 'application/pdf',
              disposition: 'attachment',
              dispositionParameters: { filename: 'big.pdf' },
              size: 6 * 1024 * 1024,
              encoding: 'base64',
            },
          ],
        },
      });
      client.download.mockResolvedValue(downloadYielding('pdf bytes'));

      await expect(
        service.downloadAttachment('test', '42', 'INBOX', 'big.pdf'),
      ).resolves.toBeDefined();
    });

    it('applies the declared base64 encoding when the server withholds MIME headers', async () => {
      // GreenMail (and flaky real servers) answer the n.MIME section of a
      // nested part empty; ImapFlow then has no transfer encoding to decode
      // with and streams raw base64 through. BODYSTRUCTURE already declared
      // the encoding, so the service applies it itself.
      client.fetchOne.mockResolvedValue({
        uid: 42,
        bodyStructure: {
          type: 'multipart/mixed',
          childNodes: [
            { part: '1', type: 'text/plain', size: 50 },
            {
              part: '2',
              type: 'image/png',
              disposition: 'attachment',
              dispositionParameters: { filename: 'logo.png' },
              size: 12,
              encoding: 'base64',
            },
          ],
        },
      });
      client.download.mockResolvedValue(downloadYielding('iVBORw0KGgo='));

      const result = await service.downloadAttachment('test', '42', 'INBOX', { partId: '2' });

      expect(Buffer.from(result.contentBase64, 'base64').toString('hex')).toBe('89504e470d0a1a0a');
    });

    it('does not decode again when ImapFlow already decoded the part', async () => {
      const raw = Buffer.from('89504e470d0a1a0a', 'hex');
      client.fetchOne.mockResolvedValue({
        uid: 42,
        bodyStructure: {
          type: 'image/png',
          disposition: 'attachment',
          dispositionParameters: { filename: 'logo.png' },
          size: 12,
          encoding: 'base64',
        },
      });
      client.download.mockResolvedValue({
        meta: { encoding: 'base64' },
        content: (async function* gen() {
          yield raw;
        })(),
      });

      const result = await service.downloadAttachment('test', '42', 'INBOX', 'logo.png');

      expect(Buffer.from(result.contentBase64, 'base64').toString('hex')).toBe(raw.toString('hex'));
    });

    it('reports the blocking size precisely instead of rounding it away', async () => {
      client.fetchOne.mockResolvedValue({
        uid: 42,
        bodyStructure: {
          type: 'application/pdf',
          disposition: 'attachment',
          dispositionParameters: { filename: 'huge.pdf' },
          size: Math.round(5.4 * 1024 * 1024),
        },
      });

      await expect(service.downloadAttachment('test', '42', 'INBOX', 'huge.pdf')).rejects.toThrow(
        /5\.4MB/,
      );
    });
  });

  // -----------------------------------------------------------------------
  // downloadAttachmentToDownloadDir
  // -----------------------------------------------------------------------

  describe('downloadAttachmentToDownloadDir', () => {
    let downloadDir: string;

    beforeEach(async () => {
      // realpath'd upfront: resolveAttachmentDownloadPath canonicalizes the
      // configured dir (macOS aliases /var to /private/var), so comparing
      // against the raw mkdtemp path would fail even on a correct result.
      downloadDir = await fs.realpath(mkdtempSync(join(tmpdir(), 'email-mcp-attach-')));
    });

    afterEach(() => {
      rmSync(downloadDir, { recursive: true, force: true });
    });

    function mockPdfAttachment(filename: string) {
      client.fetchOne.mockResolvedValue({
        uid: 42,
        bodyStructure: {
          type: 'application/pdf',
          disposition: 'attachment',
          dispositionParameters: { filename },
          size: 100,
        },
      });
      client.download.mockResolvedValue(downloadYielding('pdf bytes'));
    }

    it('writes the attachment under the configured dir using its own filename', async () => {
      mockPdfAttachment('invoice.pdf');

      const result = await service.downloadAttachmentToDownloadDir(
        'test',
        '42',
        'INBOX',
        'invoice.pdf',
        { dir: downloadDir, allowedExtensions: ['pdf'], maxBytes: 1024 },
      );

      expect(result.path).toBe(join(downloadDir, 'invoice.pdf'));
      expect(await fs.readFile(result.path, 'utf-8')).toBe('pdf bytes');
    });

    it('uses the caller-supplied saveAs name instead of the attachment filename', async () => {
      mockPdfAttachment('invoice.pdf');

      const result = await service.downloadAttachmentToDownloadDir(
        'test',
        '42',
        'INBOX',
        'invoice.pdf',
        { dir: downloadDir, allowedExtensions: ['pdf'], maxBytes: 1024 },
        'renamed.pdf',
      );

      expect(result.path).toBe(join(downloadDir, 'renamed.pdf'));
    });

    it('rejects a saveAs that is not a plain basename', async () => {
      mockPdfAttachment('invoice.pdf');

      await expect(
        service.downloadAttachmentToDownloadDir(
          'test',
          '42',
          'INBOX',
          'invoice.pdf',
          { dir: downloadDir, allowedExtensions: ['pdf'], maxBytes: 1024 },
          '../../etc/passwd',
        ),
      ).rejects.toThrow('path separators');
    });

    it('rejects an extension outside the configured allowlist', async () => {
      mockPdfAttachment('script.exe');

      await expect(
        service.downloadAttachmentToDownloadDir('test', '42', 'INBOX', 'script.exe', {
          dir: downloadDir,
          allowedExtensions: ['pdf'],
          maxBytes: 1024,
        }),
      ).rejects.toThrow('not allowed');
    });

    it('refuses to run when no download directory is configured', async () => {
      mockPdfAttachment('invoice.pdf');

      await expect(
        service.downloadAttachmentToDownloadDir('test', '42', 'INBOX', 'invoice.pdf', {
          allowedExtensions: ['pdf'],
          maxBytes: 1024,
        }),
      ).rejects.toThrow('not configured');
    });

    it('applies the configured maxBytes cap, not the base64 default', async () => {
      client.fetchOne.mockResolvedValue({
        uid: 42,
        bodyStructure: {
          type: 'application/pdf',
          disposition: 'attachment',
          dispositionParameters: { filename: 'big.pdf' },
          size: 2048,
        },
      });

      await expect(
        service.downloadAttachmentToDownloadDir('test', '42', 'INBOX', 'big.pdf', {
          dir: downloadDir,
          allowedExtensions: ['pdf'],
          maxBytes: 1024,
        }),
      ).rejects.toThrow(/exceeds/);
    });
  });

  // -----------------------------------------------------------------------
  // getCalendarParts
  // -----------------------------------------------------------------------

  describe('getCalendarParts', () => {
    /**
     * True once the bodyStructure fetch stream has been fully consumed.
     *
     * ImapFlow runs one command at a time: starting a second fetch while the
     * first response is still streaming deadlocks against the real server,
     * even though mocks happily allow it.
     */
    let outerDrained = false;

    beforeEach(() => {
      outerDrained = false;
    });

    it('drains the bodyStructure fetch before fetching a part', async () => {
      client.fetch.mockImplementationOnce(() =>
        (async function* structure() {
          try {
            yield {
              uid: 7,
              bodyStructure: {
                type: 'multipart/alternative',
                childNodes: [
                  { part: '1', type: 'text/plain', size: 50 },
                  { part: '2', type: 'text/calendar', size: 800 },
                ],
              },
            };
          } finally {
            outerDrained = true;
          }
        })(),
      );
      client.download.mockImplementation(async () => {
        expect(outerDrained).toBe(true);
        return downloadYielding('BEGIN:VCALENDAR');
      });

      await service.getCalendarParts('test', 'INBOX', '7');

      expect(outerDrained).toBe(true);
    });

    it('converts a non-UTF-8 calendar part using its declared charset', async () => {
      client.fetch.mockImplementationOnce(() =>
        (async function* structure() {
          yield {
            uid: 7,
            bodyStructure: {
              type: 'multipart/mixed',
              childNodes: [
                { part: '1', type: 'text/plain', size: 50 },
                { part: '2', type: 'text/calendar', size: 200 },
              ],
            },
          };
        })(),
      );
      // ImapFlow transfer-decodes calendar parts but does NOT charset-convert
      // them (its isTextNode list is text/plain|html only), so the raw
      // Latin-1 bytes arrive here along with the declared charset in meta.
      client.download.mockResolvedValue({
        meta: { charset: 'iso-8859-1' },
        content: (async function* gen() {
          yield Buffer.from('SUMMARY:Grüße\r\n', 'latin1');
        })(),
      });

      const parts = await service.getCalendarParts('test', 'INBOX', '7');

      expect(parts[0]).toContain('SUMMARY:Grüße');
    });

    it('returns decoded ICS text for a base64 calendar part', async () => {
      const ics = 'BEGIN:VCALENDAR\r\nSUMMARY:Review\r\nEND:VCALENDAR';

      client.fetch.mockImplementationOnce(() =>
        (async function* structure() {
          yield {
            uid: 7,
            bodyStructure: {
              type: 'multipart/mixed',
              childNodes: [
                { part: '1', type: 'text/plain', size: 50 },
                // Real servers base64-encode calendar parts; a raw bodyParts
                // fetch would hand back the undecoded base64 blob, which no
                // ICS parser can read.
                {
                  part: '2',
                  type: 'text/calendar',
                  encoding: 'base64',
                  size: 520,
                  disposition: 'attachment',
                  dispositionParameters: { filename: 'invite.ics' },
                },
              ],
            },
          };
        })(),
      );
      client.download.mockResolvedValue(downloadYielding(ics));

      const parts = await service.getCalendarParts('test', 'INBOX', '7');

      expect(parts).toHaveLength(1);
      expect(parts[0]).toContain('BEGIN:VCALENDAR');
      expect(parts[0]).not.toMatch(/^QkVHSU4/); // base64 of "BEGIN"
    });
  });

  // -----------------------------------------------------------------------
  // getThread
  // -----------------------------------------------------------------------

  describe('getThread', () => {
    it('drains the message fetch before downloading any body part', async () => {
      let outerDrained = false;

      client.search.mockResolvedValue([11]);
      client.fetchOne.mockResolvedValue({
        uid: 11,
        envelope: { subject: 'Root', messageId: '<root@x>' },
        flags: [],
        bodyStructure: { type: 'text/plain', size: 20 },
        headers: Buffer.from('Subject: Root\r\nMessage-ID: <root@x>\r\n\r\n', 'utf-8'),
      });
      client.fetch.mockImplementation(() =>
        (async function* gen() {
          try {
            yield {
              uid: 11,
              envelope: { subject: 'Root', messageId: '<root@x>' },
              flags: [],
              bodyStructure: { type: 'text/plain', size: 20 },
              headers: Buffer.from('Subject: Root\r\n\r\n', 'utf-8'),
            };
          } finally {
            outerDrained = true;
          }
        })(),
      );
      // Record rather than assert inside the mock: messageToEmail wraps the
      // download in a try/catch, which would swallow a failed expectation and
      // let this test pass while the deadlock remained.
      let drainedAtDownload: boolean | undefined;
      client.download.mockImplementation(async () => {
        drainedAtDownload ??= outerDrained;
        return downloadYielding('body');
      });

      await service.getThread('test', '<root@x>', 'INBOX');

      expect(client.download).toHaveBeenCalled();
      // ImapFlow runs one command at a time. Downloading a body part while the
      // message fetch is still streaming deadlocks the connection — against a
      // real server this hangs until the client gives up.
      expect(drainedAtDownload).toBe(true);
    });

    it('does not transfer whole messages to build a thread', async () => {
      client.search.mockResolvedValue([11]);
      client.fetch.mockImplementation(() =>
        (async function* gen() {
          yield {
            uid: 11,
            envelope: { subject: 'Root', messageId: '<root@x>' },
            flags: [],
            bodyStructure: { type: 'text/plain', size: 20 },
            headers: Buffer.from('Subject: Root\r\n\r\n', 'utf-8'),
          };
        })(),
      );
      client.download.mockResolvedValue(downloadYielding('body'));

      await service.getThread('test', '<root@x>', 'INBOX');

      // A thread caps at 50 messages; pulling full sources means up to 50
      // complete messages, attachments included, for a summary view.
      const bodyFetch = client.fetch.mock.calls.at(-1);
      expect(bodyFetch?.[1]?.source).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // Server error reporting
  // -----------------------------------------------------------------------

  describe('IMAP server rejections', () => {
    /** ImapFlow throws Error('Command failed') and puts the detail on .response. */
    function serverRejection(response: string): Error & { response: string } {
      return Object.assign(new Error('Command failed'), { response });
    }

    it('surfaces the reason the server gave for refusing a mailbox', async () => {
      client.mailboxCreate = vi
        .fn()
        .mockRejectedValue(
          serverRejection('6 NO invalid mailbox name ["X"]: operation not allowed'),
        );

      // "Command failed" alone tells the caller nothing actionable; the server
      // explained exactly what was wrong and that explanation must survive.
      await expect(service.createMailbox('test', 'X')).rejects.toThrow(/invalid mailbox name/i);
    });

    it('surfaces rejection reasons for rename and delete too', async () => {
      client.mailboxRename = vi.fn().mockRejectedValue(serverRejection('7 NO cannot rename'));
      client.mailboxDelete = vi.fn().mockRejectedValue(serverRejection('8 NO cannot delete'));

      await expect(service.renameMailbox('test', 'a', 'b')).rejects.toThrow(/cannot rename/);
      await expect(service.deleteMailbox('test', 'a')).rejects.toThrow(/cannot delete/);
    });

    it('leaves an error that carries no server response untouched', async () => {
      client.mailboxCreate = vi.fn().mockRejectedValue(new Error('ECONNRESET'));

      await expect(service.createMailbox('test', 'X')).rejects.toThrow('ECONNRESET');
    });
  });

  // -----------------------------------------------------------------------
  // Reconnect invalidation
  // -----------------------------------------------------------------------

  describe('on imap:reconnect', () => {
    afterEach(() => {
      eventBus.removeAllListeners('imap:reconnect');
    });

    /** ProtonMail is detected by a \Noselect "Labels" folder; Gmail by X-GM-EXT-1. */
    const protonLayout = [
      { name: 'Labels', path: 'Labels', flags: new Set(['\\Noselect']) },
      { name: 'Work', path: 'Labels/Work', flags: new Set() },
    ];

    it('re-detects the label strategy instead of reusing the memo', async () => {
      client.capabilities = new Set(['X-GM-EXT-1']);
      client.list.mockResolvedValue([{ name: 'Work', path: 'Work', flags: new Set() }]);

      const before = await service.listLabels('test');
      expect(before[0]!.strategy).toBe('gmail');

      // Reconnecting may land on a different server for this account, so a
      // strategy memoized against the old connection is no longer trustworthy.
      client.capabilities = new Set();
      client.list.mockResolvedValue(protonLayout);
      eventBus.emit('imap:reconnect', { account: 'test' });

      const after = await service.listLabels('test');
      expect(after[0]!.strategy).toBe('protonmail');
    });

    it('keeps the memo for accounts that did not reconnect', async () => {
      client.capabilities = new Set(['X-GM-EXT-1']);
      client.list.mockResolvedValue([{ name: 'Work', path: 'Work', flags: new Set() }]);

      await service.listLabels('test');

      client.capabilities = new Set();
      client.list.mockResolvedValue(protonLayout);
      eventBus.emit('imap:reconnect', { account: 'other-account' });

      const after = await service.listLabels('test');
      expect(after[0]!.strategy).toBe('gmail');
    });
  });

  // -----------------------------------------------------------------------
  // moveEmail
  // -----------------------------------------------------------------------

  describe('moveEmail', () => {
    it('moves email between mailboxes', async () => {
      // assertRealMailbox calls client.list() internally
      client.list.mockResolvedValue([{ name: 'INBOX', path: 'INBOX', specialUse: '\\Inbox' }]);

      await service.moveEmail('test', '42', 'INBOX', 'Archive');

      expect(client.getMailboxLock).toHaveBeenCalledWith('INBOX');
      expect(client.messageMove).toHaveBeenCalledWith('42', 'Archive', { uid: true });
      expect(client._releaseFn).toHaveBeenCalled();
    });

    it('calls sanitizeMailboxName on inputs', async () => {
      client.list.mockResolvedValue([]);

      // Passing valid names — sanitize should pass them through without error
      await service.moveEmail('test', '1', 'INBOX', 'Sent');

      expect(client.messageMove).toHaveBeenCalledWith('1', 'Sent', { uid: true });
    });
  });

  // -----------------------------------------------------------------------
  // deleteEmail
  // -----------------------------------------------------------------------

  describe('deleteEmail', () => {
    it('permanently deletes when permanent=true', async () => {
      await service.deleteEmail('test', '99', 'INBOX', true);

      expect(client.messageDelete).toHaveBeenCalledWith('99', { uid: true });
      expect(client.messageMove).not.toHaveBeenCalled();
      expect(client._releaseFn).toHaveBeenCalled();
    });

    it('moves to trash when permanent=false', async () => {
      // assertRealMailbox + trash detection both call client.list()
      client.list.mockResolvedValue([
        { name: 'INBOX', path: 'INBOX', specialUse: '\\Inbox' },
        { name: 'Trash', path: 'Trash', specialUse: '\\Trash' },
      ]);

      await service.deleteEmail('test', '99', 'INBOX', false);

      expect(client.messageDelete).not.toHaveBeenCalled();
      expect(client.messageMove).toHaveBeenCalledWith('99', 'Trash', { uid: true });
      expect(client._releaseFn).toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // setFlags
  // -----------------------------------------------------------------------

  describe('setFlags', () => {
    it('adds Seen flag for read action', async () => {
      await service.setFlags('test', '10', 'INBOX', 'read');

      expect(client.messageFlagsAdd).toHaveBeenCalledWith('10', ['\\Seen'], { uid: true });
      expect(client.messageFlagsRemove).not.toHaveBeenCalled();
    });

    it('removes Seen flag for unread action', async () => {
      await service.setFlags('test', '10', 'INBOX', 'unread');

      expect(client.messageFlagsRemove).toHaveBeenCalledWith('10', ['\\Seen'], { uid: true });
      expect(client.messageFlagsAdd).not.toHaveBeenCalled();
    });

    it('adds Flagged flag for flag action', async () => {
      await service.setFlags('test', '10', 'INBOX', 'flag');

      expect(client.messageFlagsAdd).toHaveBeenCalledWith('10', ['\\Flagged'], { uid: true });
    });
  });
});

// ---------------------------------------------------------------------------
// Write-through change events + STATUS probe (cached read path support)
// ---------------------------------------------------------------------------

describe('write-through change events', () => {
  let client: ReturnType<typeof createMockImapClient>;
  let connections: ReturnType<typeof createMockConnectionManager>;
  let service: ImapService;
  let changed: { account: string; mailbox: string }[];

  beforeEach(() => {
    client = createMockImapClient();
    connections = createMockConnectionManager(client);
    service = new ImapService(connections);
    changed = [];
    eventBus.on('email:changed', (e) => changed.push(e));
  });

  afterEach(() => {
    service.dispose();
    eventBus.removeAllListeners('email:changed');
  });

  it('emits email:changed after a successful flag write', async () => {
    await service.setFlags('test', '10', 'INBOX', 'read');

    expect(changed).toEqual([{ account: 'test', mailbox: 'INBOX' }]);
  });

  it('does not emit when the server rejects the flag write', async () => {
    client.messageFlagsAdd.mockResolvedValue(false);

    await expect(service.setFlags('test', '10', 'INBOX', 'read')).rejects.toThrow();

    expect(changed).toEqual([]);
  });

  it('emits for both source and destination on a move', async () => {
    await service.moveEmail('test', '10', 'INBOX', 'Archive');

    expect(changed).toEqual([
      { account: 'test', mailbox: 'INBOX' },
      { account: 'test', mailbox: 'Archive' },
    ]);
  });

  it('emits for the source and trash on a soft delete', async () => {
    client.list.mockResolvedValue([{ path: 'Trash', specialUse: '\\Trash' }]);

    await service.deleteEmail('test', '10', 'INBOX');

    expect(changed).toEqual([
      { account: 'test', mailbox: 'INBOX' },
      { account: 'test', mailbox: 'Trash' },
    ]);
  });

  it('emits once per mailbox for a bulk flag write', async () => {
    await service.bulkSetFlags('test', [1, 2, 3], 'INBOX', 'mark_read');

    expect(changed).toEqual([{ account: 'test', mailbox: 'INBOX' }]);
  });

  it('does not emit when the bulk write fails', async () => {
    client.messageFlagsAdd.mockResolvedValue(false);

    await service.bulkSetFlags('test', [1, 2], 'INBOX', 'mark_read');

    expect(changed).toEqual([]);
  });

  it('emits for source and destination on a bulk move', async () => {
    await service.bulkMove('test', [1, 2], 'INBOX', 'Archive');

    expect(changed).toEqual([
      { account: 'test', mailbox: 'INBOX' },
      { account: 'test', mailbox: 'Archive' },
    ]);
  });

  it('emits on a permanent bulk delete', async () => {
    await service.bulkDelete('test', [1, 2], 'INBOX', true);

    expect(changed).toEqual([{ account: 'test', mailbox: 'INBOX' }]);
  });
});

describe('getMailboxStatus', () => {
  it('maps STATUS fields, stringifying the 64-bit counters', async () => {
    const client = createMockImapClient();
    client.status.mockResolvedValue({
      uidValidity: 100n,
      uidNext: 5,
      highestModseq: 9007199254740999n,
      messages: 3,
    });
    const service = new ImapService(createMockConnectionManager(client));

    const status = await service.getMailboxStatus('test', 'INBOX');

    expect(status).toEqual({
      uidValidity: '100',
      uidNext: 5,
      highestModseq: '9007199254740999',
      messages: 3,
    });
    service.dispose();
  });

  it('leaves absent fields undefined', async () => {
    const client = createMockImapClient();
    client.status.mockResolvedValue({ messages: 3 });
    const service = new ImapService(createMockConnectionManager(client));

    const status = await service.getMailboxStatus('test', 'INBOX');

    expect(status).toEqual({
      uidValidity: undefined,
      uidNext: undefined,
      highestModseq: undefined,
      messages: 3,
    });
    service.dispose();
  });
});

// getEmailStats runs SEARCH SINCE and then FETCHes envelope, flags and
// bodyStructure for every UID in the window — a resource that only needs
// three counters was paying for all of that. getMailboxSnapshot uses STATUS
// for totals (no SELECT required) and a UID-only SEARCH for today's count.
describe('getMailboxSnapshot', () => {
  it('reads totals from STATUS and today from a UID-only SEARCH, never FETCHing', async () => {
    const client = createMockImapClient();
    client.status.mockResolvedValue({ messages: 42, unseen: 7 });
    client.search.mockResolvedValue([101, 102, 103]);
    const service = new ImapService(createMockConnectionManager(client));

    const snapshot = await service.getMailboxSnapshot('test', 'INBOX');

    expect(snapshot).toEqual({ total: 42, unread: 7, receivedToday: 3 });
    expect(client.status).toHaveBeenCalledWith('INBOX', { messages: true, unseen: true });
    expect(client.search).toHaveBeenCalledWith({ since: expect.any(Date) }, { uid: true });
    expect(client.fetch).not.toHaveBeenCalled();
    service.dispose();
  });

  it('counts only messages received since local midnight today', async () => {
    const client = createMockImapClient();
    client.status.mockResolvedValue({ messages: 1, unseen: 0 });
    const service = new ImapService(createMockConnectionManager(client));

    await service.getMailboxSnapshot('test', 'INBOX');

    const [sinceArg] = client.search.mock.calls[0] as [{ since: Date }, unknown];
    const since = sinceArg.since;
    const now = new Date();
    expect(since.getFullYear()).toBe(now.getFullYear());
    expect(since.getMonth()).toBe(now.getMonth());
    expect(since.getDate()).toBe(now.getDate());
    expect(since.getHours()).toBe(0);
    expect(since.getMinutes()).toBe(0);
    expect(since.getSeconds()).toBe(0);
    service.dispose();
  });

  it('treats missing STATUS counters as zero rather than undefined', async () => {
    const client = createMockImapClient();
    client.status.mockResolvedValue({});
    const service = new ImapService(createMockConnectionManager(client));

    const snapshot = await service.getMailboxSnapshot('test', 'INBOX');

    expect(snapshot).toEqual({ total: 0, unread: 0, receivedToday: 0 });
    service.dispose();
  });

  it('defaults to INBOX when no mailbox is given', async () => {
    const client = createMockImapClient();
    const service = new ImapService(createMockConnectionManager(client));

    await service.getMailboxSnapshot('test');

    expect(client.status).toHaveBeenCalledWith('INBOX', { messages: true, unseen: true });
    service.dispose();
  });

  it('releases the mailbox lock even when the SEARCH fails', async () => {
    const client = createMockImapClient();
    client.search.mockRejectedValue(new Error('boom'));
    const service = new ImapService(createMockConnectionManager(client));

    await expect(service.getMailboxSnapshot('test', 'INBOX')).rejects.toThrow('boom');

    expect(client._releaseFn).toHaveBeenCalled();
    service.dispose();
  });
});

describe('label writes invalidate the mirror', () => {
  let client: ReturnType<typeof createMockImapClient>;
  let service: ImapService;
  let changed: { account: string; mailbox: string }[];

  beforeEach(() => {
    client = createMockImapClient();
    client.list.mockResolvedValue([{ path: 'INBOX', specialUse: '\\Inbox', flags: new Set() }]);
    service = new ImapService(createMockConnectionManager(client));
    changed = [];
    eventBus.on('email:changed', (e) => changed.push(e));
  });

  afterEach(() => {
    service.dispose();
    eventBus.removeAllListeners('email:changed');
  });

  it('emits email:changed after adding a label', async () => {
    await service.addLabel('test', '10', 'INBOX', 'Work');

    // On a keyword-strategy server a label is a flag write: it moves neither
    // UIDNEXT nor MESSAGES, so STATUS cannot reveal it and only this event
    // keeps the next read correct.
    expect(changed).toEqual([{ account: 'test', mailbox: 'INBOX' }]);
  });

  it('emits email:changed after removing a label', async () => {
    await service.removeLabel('test', '10', 'INBOX', 'Work');

    expect(changed).toEqual([{ account: 'test', mailbox: 'INBOX' }]);
  });
});

// ---------------------------------------------------------------------------
// findEmailFolder: stop at the first match, search likely folders first
//
// Each folder costs a SELECT and a header SEARCH, and header SEARCH is
// typically an unindexed server-side scan — continuing after a match spent
// that on every remaining folder to build a list the caller was told to use
// only the first entry of.
// ---------------------------------------------------------------------------

describe('ImapService.findEmailFolder', () => {
  let client: ReturnType<typeof createMockImapClient>;
  let service: ImapService;

  /** Mailboxes as client.list() returns them, in an unhelpful order. */
  const mailboxes = [
    { path: 'Archives2019', listed: true, flags: new Set<string>() },
    { path: 'Klakedelle', listed: true, flags: new Set<string>() },
    { path: 'Sent', listed: true, flags: new Set<string>(), specialUse: '\\Sent' },
    { path: 'INBOX', listed: true, flags: new Set<string>() },
    { path: 'Travaux', listed: true, flags: new Set<string>() },
  ];

  beforeEach(() => {
    client = createMockImapClient();
    service = new ImapService(createMockConnectionManager(client));
    client.fetchOne.mockResolvedValue({
      headers: Buffer.from('Message-ID: <target@example.com>\r\n'),
    });
    client.list.mockResolvedValue(mailboxes);
  });

  /** Make the Message-ID search hit in exactly one mailbox. */
  function messageLivesIn(path: string) {
    let currentMailbox = '';
    client.getMailboxLock.mockImplementation(async (mailboxPath: string) => {
      currentMailbox = mailboxPath;
      return { release: vi.fn() };
    });
    client.search.mockImplementation(async () => (currentMailbox === path ? [42] : []));
  }

  it('searches INBOX before any other folder', async () => {
    messageLivesIn('INBOX');

    const result = await service.findEmailFolder('test', '42', 'INBOX');

    expect(result.folders).toEqual(['INBOX']);
    // One SELECT and one SEARCH, not one per folder.
    expect(client.search).toHaveBeenCalledTimes(1);
  });

  it('stops as soon as a folder matches', async () => {
    messageLivesIn('Sent');

    const result = await service.findEmailFolder('test', '42', 'INBOX');

    expect(result.folders).toEqual(['Sent']);
    // INBOX then Sent — the three remaining folders are never selected, which
    // is the whole point.
    expect(client.search).toHaveBeenCalledTimes(2);
  });

  it('still finds a message in an ordinary folder', async () => {
    messageLivesIn('Klakedelle');

    const result = await service.findEmailFolder('test', '42', 'INBOX');

    expect(result.folders).toEqual(['Klakedelle']);
  });

  it('reports no folder when nothing matches', async () => {
    messageLivesIn('nowhere');

    const result = await service.findEmailFolder('test', '42', 'INBOX');

    expect(result.folders).toEqual([]);
    expect(result.messageId).toBe('<target@example.com>');
  });

  it('keeps searching past a folder it cannot select', async () => {
    let currentMailbox = '';
    client.getMailboxLock.mockImplementation(async (mailboxPath: string) => {
      currentMailbox = mailboxPath;
      // Sent is searched second, before the match — an unselectable folder
      // there must not abandon the hunt.
      if (mailboxPath === 'Sent') throw new Error('NO [SERVERBUG] cannot select');
      return { release: vi.fn() };
    });
    client.search.mockImplementation(async () => (currentMailbox === 'Klakedelle' ? [42] : []));

    const result = await service.findEmailFolder('test', '42', 'INBOX');

    expect(result.folders).toEqual(['Klakedelle']);
  });
});
