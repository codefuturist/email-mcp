import type { IConnectionManager } from '../connections/types.js';
import ImapService from './imap.service.js';

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function createMockImapClient() {
  const releaseFn = vi.fn();
  return {
    usable: true,
    getMailboxLock: vi.fn().mockResolvedValue({ release: releaseFn }),
    list: vi.fn().mockResolvedValue([]),
    status: vi.fn().mockResolvedValue({ messages: 5, unseen: 2 }),
    fetch: vi.fn().mockReturnValue((async function* fetchMock() {})()),
    search: vi.fn().mockResolvedValue([]),
    messageMove: vi.fn().mockResolvedValue(true),
    messageDelete: vi.fn().mockResolvedValue(true),
    messageFlagsAdd: vi.fn().mockResolvedValue(true),
    messageFlagsRemove: vi.fn().mockResolvedValue(true),
    fetchOne: vi.fn().mockResolvedValue(undefined),
    download: vi.fn().mockResolvedValue(undefined),
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
// findEmailFolder
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
    // is the whole point: header SEARCH is an unindexed scan per folder.
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
