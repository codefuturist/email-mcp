import type { IConnectionManager } from '../connections/types.js';
import type RateLimiter from '../safety/rate-limiter.js';
import type ImapService from './imap.service.js';
import SmtpService from './smtp.service.js';

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function createMockTransport() {
  return {
    sendMail: vi.fn().mockResolvedValue({ messageId: '<test@example.com>' }),
  };
}

function createMockConnectionManager(mockTransport: ReturnType<typeof createMockTransport>) {
  return {
    getAccount: vi.fn().mockReturnValue({
      name: 'test',
      email: 'test@example.com',
      fullName: 'Test User',
      username: 'test@example.com',
      imap: { host: 'imap.example.com', port: 993, tls: true, starttls: false, verifySsl: true },
      smtp: { host: 'smtp.example.com', port: 465, tls: true, starttls: false, verifySsl: true },
    }),
    getAccountNames: vi.fn().mockReturnValue(['test']),
    getImapClient: vi.fn(),
    getSmtpTransport: vi.fn().mockResolvedValue(mockTransport),
    closeAll: vi.fn(),
  } satisfies IConnectionManager;
}

function createMockRateLimiter(allowed = true) {
  return {
    tryConsume: vi.fn().mockReturnValue(allowed),
    remaining: vi.fn().mockReturnValue(allowed ? 9 : 0),
  } as unknown as RateLimiter;
}

function createMockImapService() {
  return {
    appendToSent: vi.fn().mockResolvedValue('INBOX.Sent'),
  } as unknown as ImapService;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SmtpService', () => {
  let transport: ReturnType<typeof createMockTransport>;
  let connections: ReturnType<typeof createMockConnectionManager>;
  let rateLimiter: RateLimiter;
  let imapService: ReturnType<typeof createMockImapService>;
  let service: SmtpService;

  beforeEach(() => {
    transport = createMockTransport();
    connections = createMockConnectionManager(transport);
    rateLimiter = createMockRateLimiter(true);
    imapService = createMockImapService();
    service = new SmtpService(connections, rateLimiter, imapService);
  });

  describe('sendEmail', () => {
    it('sends email via SMTP transport', async () => {
      const result = await service.sendEmail('test', {
        to: ['recipient@example.com'],
        subject: 'Hello',
        body: 'World',
      });

      expect(result).toEqual({
        messageId: '<test@example.com>',
        status: 'sent',
        archivedTo: 'INBOX.Sent',
      });
      expect(transport.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          from: '"Test User" <test@example.com>',
          to: 'recipient@example.com',
          subject: 'Hello',
          text: 'World',
        }),
      );
    });

    it('throws when rate limited', async () => {
      rateLimiter = createMockRateLimiter(false);
      service = new SmtpService(connections, rateLimiter, createMockImapService());

      await expect(
        service.sendEmail('test', {
          to: ['recipient@example.com'],
          subject: 'Hello',
          body: 'World',
        }),
      ).rejects.toThrow('Rate limit exceeded');

      expect(transport.sendMail).not.toHaveBeenCalled();
    });

    it('includes CC and BCC when provided', async () => {
      await service.sendEmail('test', {
        to: ['a@example.com'],
        subject: 'Test',
        body: 'Body',
        cc: ['cc1@example.com', 'cc2@example.com'],
        bcc: ['bcc@example.com'],
      });

      expect(transport.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          cc: 'cc1@example.com, cc2@example.com',
          bcc: 'bcc@example.com',
        }),
      );
    });

    it('sends as HTML when html=true', async () => {
      await service.sendEmail('test', {
        to: ['a@example.com'],
        subject: 'HTML Test',
        body: '<h1>Hello</h1>',
        html: true,
      });

      const call = transport.sendMail.mock.calls[0][0];
      expect(call.html).toBe('<h1>Hello</h1>');
      expect(call.text).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // Sent copy
  // -----------------------------------------------------------------------

  describe('filing a copy in Sent', () => {
    it('files every sent message and reports the folder', async () => {
      const result = await service.sendEmail('test', {
        to: ['recipient@example.com'],
        subject: 'Hello',
        body: 'World',
      });

      expect(imapService.appendToSent).toHaveBeenCalledOnce();
      expect(result.archivedTo).toBe('INBOX.Sent');
      expect(result.archiveError).toBeUndefined();
    });

    it('files a copy carrying the Message-ID that SMTP returned', async () => {
      transport.sendMail.mockResolvedValue({ messageId: '<real-id@example.com>' });

      await service.sendEmail('test', {
        to: ['recipient@example.com'],
        subject: 'Hello',
        body: 'World',
      });

      const [, raw] = (imapService.appendToSent as unknown as ReturnType<typeof vi.fn>).mock
        .calls[0] as [string, Buffer];
      expect(raw.toString()).toContain('Message-ID: <real-id@example.com>');
      expect(raw.toString()).toContain('Subject: Hello');
    });

    it('reports a send as sent even when filing the copy fails', async () => {
      (imapService.appendToSent as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('NO [TRYCREATE] Mailbox does not exist'),
      );

      const result = await service.sendEmail('test', {
        to: ['recipient@example.com'],
        subject: 'Hello',
        body: 'World',
      });

      expect(result.status).toBe('sent');
      expect(result.messageId).toBe('<test@example.com>');
      expect(result.archivedTo).toBeNull();
      expect(result.archiveError).toContain('Mailbox does not exist');
    });

    it('files a copy for replies, forwards and drafts too, not only plain sends', async () => {
      const imap = imapService as unknown as {
        appendToSent: ReturnType<typeof vi.fn>;
        getEmail: ReturnType<typeof vi.fn>;
        fetchDraft: ReturnType<typeof vi.fn>;
        deleteDraft: ReturnType<typeof vi.fn>;
      };
      imap.getEmail = vi.fn().mockResolvedValue({
        from: { address: 'them@example.com' },
        to: [{ address: 'test@example.com' }],
        subject: 'Original',
        messageId: '<orig@example.com>',
        date: '2026-01-01',
        bodyText: 'body',
      });
      imap.fetchDraft = vi.fn().mockResolvedValue({
        email: {
          to: [{ address: 'recipient@example.com' }],
          subject: 'Draft',
          bodyText: 'draft body',
        },
        mailbox: 'INBOX.Drafts',
      });
      imap.deleteDraft = vi.fn().mockResolvedValue(undefined);

      await service.replyToEmail('test', { emailId: '1', body: 'reply' });
      await service.forwardEmail('test', { emailId: '1', to: ['other@example.com'] });
      await service.sendDraft('test', 1);

      expect(imap.appendToSent).toHaveBeenCalledTimes(3);
    });
  });
});
