import type { IConnectionManager } from '../connections/types.js';
import type RateLimiter from '../safety/rate-limiter.js';
import type ImapService from './imap.service.js';
import SmtpService from './smtp.service.js';

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function createMockTransport() {
  return {
    sendMail: vi.fn().mockResolvedValue({ messageId: '<ignored-by-service@example.com>' }),
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

/** Default ImapService mock: Sent-copy archiving succeeds. */
function createMockImapService(overrides: Partial<ImapService> = {}) {
  return {
    appendToSent: vi.fn().mockResolvedValue({ mailbox: 'Sent', uid: 1 }),
    ...overrides,
  } as unknown as ImapService;
}

function getRawMessageText(transport: ReturnType<typeof createMockTransport>): string {
  const call = transport.sendMail.mock.calls[0][0];
  return (call.raw as Buffer).toString('utf-8');
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
    it('sends a raw MIME message via SMTP with the right headers and body', async () => {
      const result = await service.sendEmail('test', {
        to: ['recipient@example.com'],
        subject: 'Hello',
        body: 'World',
      });

      expect(result.status).toBe('sent');
      expect(result.messageId).toMatch(/^<[\w-]+@example\.com>$/);

      const call = transport.sendMail.mock.calls[0][0];
      expect(call.raw).toBeInstanceOf(Buffer);
      expect(call.envelope).toEqual({ from: 'test@example.com', to: ['recipient@example.com'] });

      const text = getRawMessageText(transport);
      expect(text).toMatch(/^From: .*Test User.*<test@example\.com>/m);
      expect(text).toContain('To: recipient@example.com');
      expect(text).toContain('Subject: Hello');
      expect(text).toContain(`Message-ID: ${result.messageId}`);
      expect(text).toContain('World');
    });

    it('throws when rate limited', async () => {
      rateLimiter = createMockRateLimiter(false);
      service = new SmtpService(connections, rateLimiter, imapService);

      await expect(
        service.sendEmail('test', {
          to: ['recipient@example.com'],
          subject: 'Hello',
          body: 'World',
        }),
      ).rejects.toThrow('Rate limit exceeded');

      expect(transport.sendMail).not.toHaveBeenCalled();
    });

    it('routes CC and BCC to the SMTP envelope, but keeps BCC out of the message headers', async () => {
      await service.sendEmail('test', {
        to: ['a@example.com'],
        subject: 'Test',
        body: 'Body',
        cc: ['cc1@example.com', 'cc2@example.com'],
        bcc: ['bcc@example.com'],
      });

      const call = transport.sendMail.mock.calls[0][0];
      expect(call.envelope.to).toEqual([
        'a@example.com',
        'cc1@example.com',
        'cc2@example.com',
        'bcc@example.com',
      ]);

      const text = getRawMessageText(transport);
      expect(text).toContain('Cc: cc1@example.com, cc2@example.com');
      expect(text).not.toContain('bcc@example.com');
      expect(text).not.toMatch(/^Bcc:/m);
    });

    it('sends as HTML when html=true', async () => {
      await service.sendEmail('test', {
        to: ['a@example.com'],
        subject: 'HTML Test',
        body: '<h1>Hello</h1>',
        html: true,
      });

      const text = getRawMessageText(transport);
      expect(text).toContain('Content-Type: text/html');
      expect(text).toContain('<h1>Hello</h1>');
    });

    it('archives the exact same bytes that were sent to the Sent mailbox', async () => {
      const result = await service.sendEmail('test', {
        to: ['recipient@example.com'],
        subject: 'Hello',
        body: 'World',
      });

      const sentBytes = transport.sendMail.mock.calls[0][0].raw as Buffer;
      const archivedBytes = (imapService.appendToSent as ReturnType<typeof vi.fn>).mock
        .calls[0][1] as Buffer;

      expect(archivedBytes).toBe(sentBytes);
      expect(result.sentCopy).toEqual({ saved: true, mailbox: 'Sent' });
    });

    it('reports a warning instead of failing when the Sent-copy append fails', async () => {
      imapService = createMockImapService({
        appendToSent: vi.fn().mockRejectedValue(new Error('mailbox unavailable')),
      });
      service = new SmtpService(connections, rateLimiter, imapService);

      const result = await service.sendEmail('test', {
        to: ['recipient@example.com'],
        subject: 'Hello',
        body: 'World',
      });

      expect(result.status).toBe('sent');
      expect(result.sentCopy?.saved).toBe(false);
      expect(result.sentCopy?.warning).toContain('mailbox unavailable');
    });
  });

  describe('replyToEmail', () => {
    function createMockImapServiceWithEmail() {
      return createMockImapService({
        getEmail: vi.fn().mockResolvedValue({
          id: '1',
          subject: 'Original subject',
          from: { address: 'sender@example.com' },
          to: [{ address: 'test@example.com' }],
          cc: [{ address: 'other@example.com' }],
          date: new Date().toISOString(),
          messageId: '<original@example.com>',
          references: [],
        }),
      });
    }

    it('threads the reply and archives it to Sent', async () => {
      imapService = createMockImapServiceWithEmail();
      service = new SmtpService(connections, rateLimiter, imapService);

      const result = await service.replyToEmail('test', {
        emailId: '1',
        body: 'Thanks!',
      });

      const text = getRawMessageText(transport);
      expect(text).toContain('To: sender@example.com');
      expect(text).toContain('Subject: Re: Original subject');
      expect(text).toContain('In-Reply-To: <original@example.com>');
      expect(text).toContain('References: <original@example.com>');
      expect(result.sentCopy).toEqual({ saved: true, mailbox: 'Sent' });
    });

    it('includes other recipients on replyAll but excludes ourselves', async () => {
      imapService = createMockImapServiceWithEmail();
      service = new SmtpService(connections, rateLimiter, imapService);

      await service.replyToEmail('test', {
        emailId: '1',
        body: 'Thanks all!',
        replyAll: true,
      });

      const call = transport.sendMail.mock.calls[0][0];
      expect(call.envelope.to).toEqual(['sender@example.com', 'other@example.com']);
    });
  });

  describe('forwardEmail', () => {
    function createMockImapServiceWithEmail() {
      return createMockImapService({
        getEmail: vi.fn().mockResolvedValue({
          id: '1',
          subject: 'Original',
          from: { address: 'sender@example.com' },
          to: [{ address: 'test@example.com' }],
          date: new Date().toISOString(),
          bodyText: 'Original body',
          attachments: [],
        }),
      });
    }

    it('sends the forwarded email and archives it to Sent', async () => {
      imapService = createMockImapServiceWithEmail();
      service = new SmtpService(connections, rateLimiter, imapService);

      const result = await service.forwardEmail('test', {
        emailId: '1',
        to: ['dest@example.com'],
      });

      const text = getRawMessageText(transport);
      expect(text).toContain('Subject: Fwd: Original');
      expect(text).toContain('Original body');
      expect(result.sentCopy).toEqual({ saved: true, mailbox: 'Sent' });
    });
  });

  describe('sendDraft', () => {
    function createMockImapServiceWithDraft() {
      return createMockImapService({
        fetchDraft: vi.fn().mockResolvedValue({
          email: {
            id: '5',
            subject: 'Draft subject',
            to: [{ address: 'dest@example.com' }],
            bcc: [{ address: 'hidden@example.com' }],
            bodyText: 'Draft body',
          },
          mailbox: 'Drafts',
        }),
        deleteDraft: vi.fn().mockResolvedValue(undefined),
      });
    }

    it('sends the draft, archives it to Sent, and deletes the draft', async () => {
      imapService = createMockImapServiceWithDraft();
      service = new SmtpService(connections, rateLimiter, imapService);

      const result = await service.sendDraft('test', 5);

      const call = transport.sendMail.mock.calls[0][0];
      expect(call.envelope.to).toEqual(['dest@example.com', 'hidden@example.com']);
      const text = getRawMessageText(transport);
      expect(text).not.toContain('hidden@example.com');

      expect(result.sentCopy).toEqual({ saved: true, mailbox: 'Sent' });
      expect(imapService.deleteDraft).toHaveBeenCalledWith('test', 5, 'Drafts');
    });
  });
});
