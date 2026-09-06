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
    append: vi.fn().mockResolvedValue({ uid: 7 }),
    capabilities: new Set<string>(),
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

  // -----------------------------------------------------------------------
  // appendToSent
  // -----------------------------------------------------------------------

  describe('appendToSent', () => {
    it('files the copy in the folder the server flags as \\Sent', async () => {
      client.list.mockResolvedValue([
        { name: 'INBOX', path: 'INBOX', specialUse: '\\Inbox' },
        { name: 'Drafts', path: 'INBOX.draft', specialUse: '\\Drafts' },
        { name: 'Sent', path: 'INBOX.Sent Messages', specialUse: '\\Sent' },
      ]);

      const path = await service.appendToSent('test', Buffer.from('raw message'));

      expect(path).toBe('INBOX.Sent Messages');
      expect(client.append).toHaveBeenCalledWith(
        'INBOX.Sent Messages',
        Buffer.from('raw message'),
        ['\\Seen'],
      );
    });

    it('falls back to "Sent" when the server flags no folder', async () => {
      client.list.mockResolvedValue([{ name: 'INBOX', path: 'INBOX', specialUse: '\\Inbox' }]);

      const path = await service.appendToSent('test', Buffer.from('raw'));

      expect(path).toBe('Sent');
    });

    it("prefers the configured sent_mailbox over the client's guess", async () => {
      connections.getAccount.mockReturnValue({
        name: 'test',
        email: 'test@example.com',
        username: 'test@example.com',
        sentMailbox: 'INBOX.Sent Messages',
        imap: { host: 'imap.example.com', port: 993, tls: true, starttls: false, verifySsl: true },
        smtp: { host: 'smtp.example.com', port: 465, tls: true, starttls: false, verifySsl: true },
      });
      client.list.mockResolvedValue([
        { name: 'Sent', path: 'INBOX.INBOX.Sent', specialUse: '\\Sent' },
      ]);

      const path = await service.appendToSent('test', Buffer.from('raw'));

      expect(path).toBe('INBOX.Sent Messages');
      expect(client.append).toHaveBeenCalledWith('INBOX.Sent Messages', expect.any(Buffer), [
        '\\Seen',
      ]);
      // the override settles it, so there is nothing to look up
      expect(client.list).not.toHaveBeenCalled();
    });

    // Gmail files SMTP sends into Sent Mail itself; appending on top of that
    // gives the user every sent message twice.
    it('skips the copy on a server that files sent mail itself', async () => {
      const gmailClient = createMockImapClient();
      gmailClient.capabilities.add('X-GM-EXT-1');
      const svc = new ImapService(createMockConnectionManager(gmailClient) as never);

      const path = await svc.appendToSent('test', Buffer.from('raw'));

      expect(path).toBeNull();
      expect(gmailClient.append).not.toHaveBeenCalled();
    });

    it('files the copy anyway when the account asks for it explicitly', async () => {
      const gmailClient = createMockImapClient();
      gmailClient.capabilities.add('X-GM-EXT-1');
      const manager = createMockConnectionManager(gmailClient);
      manager.getAccount = vi.fn().mockReturnValue({ name: 'test', saveToSent: true });
      const svc = new ImapService(manager as never);

      expect(await svc.appendToSent('test', Buffer.from('raw'))).not.toBeNull();
      expect(gmailClient.append).toHaveBeenCalledOnce();
    });

    it('honours save_to_sent = false on a server that does not file it', async () => {
      const plainClient = createMockImapClient();
      const manager = createMockConnectionManager(plainClient);
      manager.getAccount = vi.fn().mockReturnValue({ name: 'test', saveToSent: false });
      const svc = new ImapService(manager as never);

      expect(await svc.appendToSent('test', Buffer.from('raw'))).toBeNull();
      expect(plainClient.append).not.toHaveBeenCalled();
    });

    it('marks the copy read so it does not show up as unread mail', async () => {
      client.list.mockResolvedValue([{ name: 'Sent', path: 'Sent', specialUse: '\\Sent' }]);

      await service.appendToSent('test', Buffer.from('raw'));

      expect(client.append).toHaveBeenCalledWith('Sent', expect.any(Buffer), ['\\Seen']);
    });
  });
});
