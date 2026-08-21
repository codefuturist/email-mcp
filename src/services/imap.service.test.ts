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
      expect(result[1].totalMessages).toBeUndefined();
      expect(result[1].unseenMessages).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // listEmails
  // -----------------------------------------------------------------------

  describe('listEmails', () => {
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

      expect(result.items[0].id).toBe('77');
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
      const [, query] = client.fetchOne.mock.calls[0];
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

    it('reports a well-formed attachment mimeType', async () => {
      client.download.mockResolvedValue(downloadYielding('body'));

      const email = await service.getEmail('test', '42', 'INBOX');

      // ImapFlow's `type` is already the full Content-Type, so appending a
      // non-existent `subtype` yields "application/pdf/octet-stream".
      expect(email.attachments[0].mimeType).toBe('application/pdf');
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

      const email = await service.getEmail('test', '42', 'INBOX');

      // Headers and metadata are still useful even when the server refuses
      // the body part, so this degrades rather than failing the whole call.
      expect(email.subject).toBe('Simple');
      expect(email.bodyText).toBeUndefined();
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
      expect(before[0].strategy).toBe('gmail');

      // Reconnecting may land on a different server for this account, so a
      // strategy memoized against the old connection is no longer trustworthy.
      client.capabilities = new Set();
      client.list.mockResolvedValue(protonLayout);
      eventBus.emit('imap:reconnect', { account: 'test' });

      const after = await service.listLabels('test');
      expect(after[0].strategy).toBe('protonmail');
    });

    it('keeps the memo for accounts that did not reconnect', async () => {
      client.capabilities = new Set(['X-GM-EXT-1']);
      client.list.mockResolvedValue([{ name: 'Work', path: 'Work', flags: new Set() }]);

      await service.listLabels('test');

      client.capabilities = new Set();
      client.list.mockResolvedValue(protonLayout);
      eventBus.emit('imap:reconnect', { account: 'other-account' });

      const after = await service.listLabels('test');
      expect(after[0].strategy).toBe('gmail');
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
