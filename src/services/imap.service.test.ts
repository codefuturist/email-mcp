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
    append: vi.fn().mockResolvedValue({ uid: 42 }),
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
  // saveDraft
  // -----------------------------------------------------------------------

  describe('saveDraft', () => {
    it('builds a MIME message via MailComposer when there are no attachments', async () => {
      const result = await service.saveDraft('test', {
        to: ['dest@example.com'],
        subject: 'Hello',
        body: 'World',
      });

      expect(result).toEqual({ id: 42, mailbox: 'Drafts' });
      const [mailbox, raw, flags] = client.append.mock.calls[0];
      expect(mailbox).toBe('Drafts');
      expect(flags).toEqual(['\\Draft', '\\Seen']);
      expect(Buffer.isBuffer(raw)).toBe(true);
      const text = (raw as Buffer).toString('utf-8');
      expect(text).toMatch(/Subject:.*Hello/);
      expect(text).toContain('dest@example.com');
      expect(text).toContain('World');
      expect(text).toMatch(/MIME-Version:/i);
    });

    it('builds a multipart MIME message with the attachment when attachments are provided', async () => {
      const result = await service.saveDraft('test', {
        to: ['dest@example.com'],
        subject: 'With attachment',
        body: 'See attached',
        attachments: [
          {
            filename: 'note.txt',
            content: Buffer.from('hello').toString('base64'),
            contentType: 'text/plain',
          },
        ],
      });

      expect(result).toEqual({ id: 42, mailbox: 'Drafts' });
      const [, raw] = client.append.mock.calls[0];
      const text = (raw as Buffer).toString('utf-8');
      expect(text).toContain('multipart/mixed');
      expect(text).toContain('Content-Disposition: attachment; filename=note.txt');
      expect(text).toContain(Buffer.from('hello').toString('base64'));
      expect(text).toContain('See attached');
    });

    it('rejects invalid attachments before appending', async () => {
      await expect(
        service.saveDraft('test', {
          to: ['dest@example.com'],
          subject: 'Bad',
          body: 'oops',
          attachments: [{ filename: 'note.txt' }],
        }),
      ).rejects.toThrow('exactly one of "content"');

      expect(client.append).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // saveReplyDraft
  // -----------------------------------------------------------------------

  describe('saveReplyDraft', () => {
    it('appends a threaded reply to the Drafts folder without sending', async () => {
      client.list.mockResolvedValue([
        { path: 'INBOX' },
        { path: 'Drafts', specialUse: '\\Drafts' },
      ]);
      const append = vi.fn().mockResolvedValue({ uid: 501 });
      Object.assign(client, { append });
      const getEmail = vi.spyOn(service, 'getEmail').mockResolvedValue({
        id: '123',
        subject: 'Agreement',
        from: { name: 'Tom', address: 'tom@example.org' },
        to: [{ address: 'test@example.com' }],
        date: '2026-09-16T08:15:00.000Z',
        seen: true,
        flagged: false,
        answered: false,
        hasAttachments: false,
        labels: [],
        messageId: '<orig@example.org>',
        bodyText: 'Please sign.',
        attachments: [],
        headers: {},
      });

      const result = await service.saveReplyDraft('test', {
        emailId: '123',
        mailbox: 'INBOX',
        body: 'Signed copy attached.',
      });

      expect(getEmail).toHaveBeenCalledWith('test', '123', 'INBOX');
      expect(append).toHaveBeenCalledTimes(1);
      const [path, raw, flags] = append.mock.calls[0] as [string, Buffer, string[]];
      expect(path).toBe('Drafts');
      expect(flags).toEqual(['\\Draft', '\\Seen']);
      const message = raw.toString('utf8');
      expect(message).toMatch(/^In-Reply-To: <orig@example\.org>/m);
      expect(message).toMatch(/^References: <orig@example\.org>/m);
      expect(message).toMatch(/^Subject: Re: Agreement/m);
      expect(message).toMatch(/^To: "?Tom"? <tom@example\.org>/m);
      expect(message).toContain('history_container');
      expect(message).not.toContain('<pre>');
      expect(connections.getSmtpTransport).not.toHaveBeenCalled();
      expect(result).toEqual({
        id: 501,
        mailbox: 'Drafts',
        subject: 'Re: Agreement',
        to: ['tom@example.org'],
        cc: [],
        inReplyTo: '<orig@example.org>',
      });
    });

    it('includes attachments in the reply draft MIME', async () => {
      client.list.mockResolvedValue([{ path: 'Drafts', specialUse: '\\Drafts' }]);
      const append = vi.fn().mockResolvedValue({ uid: 502 });
      Object.assign(client, { append });
      vi.spyOn(service, 'getEmail').mockResolvedValue({
        id: '123',
        subject: 'Agreement',
        from: { name: 'Tom', address: 'tom@example.org' },
        to: [{ address: 'test@example.com' }],
        date: '2026-09-16T08:15:00.000Z',
        seen: true,
        flagged: false,
        answered: false,
        hasAttachments: false,
        labels: [],
        messageId: '<orig@example.org>',
        bodyText: 'Please sign.',
        attachments: [],
        headers: {},
      });

      await service.saveReplyDraft('test', {
        emailId: '123',
        body: 'Signed.',
        attachments: [
          {
            filename: 'signed.pdf',
            content: Buffer.from('pdf-bytes').toString('base64'),
            contentType: 'application/pdf',
          },
        ],
      });

      const [, raw] = append.mock.calls[0] as [string, Buffer, string[]];
      const message = raw.toString('utf8');
      expect(message).toContain('multipart/mixed');
      expect(message).toContain('Content-Disposition: attachment; filename=signed.pdf');
      expect(message).toContain(Buffer.from('pdf-bytes').toString('base64'));
    });
  });
});
