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

function createMockImapService(overrides: Partial<ImapService> = {}) {
  return overrides as unknown as ImapService;
}

function makeOriginalEmail() {
  return {
    id: '42',
    subject: 'Project update',
    from: { name: 'Alex', address: 'alex@example.com' },
    to: [{ address: 'test@example.com' }],
    cc: [],
    date: 'Mon, 25 May 2026 16:11:00 +0200',
    seen: true,
    flagged: false,
    answered: false,
    hasAttachments: false,
    labels: [],
    messageId: '<orig-42@example.com>',
    references: ['<root@example.com>'],
    bodyText: 'Where are we on the launch?',
    attachments: [],
    headers: {},
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SmtpService', () => {
  let transport: ReturnType<typeof createMockTransport>;
  let connections: ReturnType<typeof createMockConnectionManager>;
  let rateLimiter: RateLimiter;
  let service: SmtpService;

  beforeEach(() => {
    transport = createMockTransport();
    connections = createMockConnectionManager(transport);
    rateLimiter = createMockRateLimiter(true);
    service = new SmtpService(connections, rateLimiter, createMockImapService());
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

  describe('replyToEmail quote_original', () => {
    it('appends quoted original below text reply by default', async () => {
      const imap = createMockImapService({
        getEmail: vi.fn().mockResolvedValue(makeOriginalEmail()),
      } as unknown as Partial<ImapService>);
      service = new SmtpService(connections, rateLimiter, imap);

      await service.replyToEmail('test', {
        emailId: '42',
        body: 'On it tomorrow.',
      });

      const call = transport.sendMail.mock.calls[0][0];
      expect(call.text).toContain('On it tomorrow.');
      expect(call.text).toContain(
        'On Mon, 25 May 2026 16:11:00 +0200, Alex <alex@example.com> wrote:',
      );
      expect(call.text).toContain('> Where are we on the launch?');
      expect(call.subject).toBe('Re: Project update');
      expect(call.inReplyTo).toBe('<orig-42@example.com>');
      expect(call.references).toContain('<root@example.com>');
      expect(call.references).toContain('<orig-42@example.com>');
    });

    it('appends <blockquote type="cite"> for HTML replies', async () => {
      const imap = createMockImapService({
        getEmail: vi.fn().mockResolvedValue({
          ...makeOriginalEmail(),
          bodyHtml: '<p>Where are we?</p>',
        }),
      } as unknown as Partial<ImapService>);
      service = new SmtpService(connections, rateLimiter, imap);

      await service.replyToEmail('test', {
        emailId: '42',
        body: '<p>On it tomorrow.</p>',
        html: true,
      });

      const call = transport.sendMail.mock.calls[0][0];
      expect(call.html).toContain('<p>On it tomorrow.</p>');
      expect(call.html).toContain('<blockquote type="cite"');
      expect(call.html).toContain('<p>Where are we?</p>');
      expect(call.text).toBeUndefined();
    });

    it('does not append quoted block when quoteOriginal=false', async () => {
      const imap = createMockImapService({
        getEmail: vi.fn().mockResolvedValue(makeOriginalEmail()),
      } as unknown as Partial<ImapService>);
      service = new SmtpService(connections, rateLimiter, imap);

      await service.replyToEmail('test', {
        emailId: '42',
        body: 'On it tomorrow.',
        quoteOriginal: false,
      });

      const call = transport.sendMail.mock.calls[0][0];
      expect(call.text).toBe('On it tomorrow.');
      expect(call.text).not.toContain('wrote:');
      expect(call.text).not.toContain('>');
    });
  });
});
