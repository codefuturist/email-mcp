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
  return {} as unknown as ImapService;
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

    it('decodes and sends base64 attachments', async () => {
      await service.sendEmail('test', {
        to: ['a@example.com'],
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

      const call = transport.sendMail.mock.calls[0][0];
      expect(call.attachments).toEqual([
        { filename: 'note.txt', content: Buffer.from('hello'), contentType: 'text/plain' },
      ]);
    });

    it('rejects invalid attachments before sending', async () => {
      await expect(
        service.sendEmail('test', {
          to: ['a@example.com'],
          subject: 'Bad attachment',
          body: 'oops',
          attachments: [{ filename: 'note.txt' }],
        }),
      ).rejects.toThrow('exactly one of "content"');

      expect(transport.sendMail).not.toHaveBeenCalled();
    });
  });

  describe('forwardEmail', () => {
    function createMockImapServiceWithEmail(
      attachments: { filename: string; mimeType: string; size: number }[],
    ) {
      return {
        getEmail: vi.fn().mockResolvedValue({
          id: '1',
          subject: 'Original',
          from: { address: 'sender@example.com' },
          to: [{ address: 'test@example.com' }],
          date: new Date().toISOString(),
          bodyText: 'Original body',
          attachments,
        }),
        downloadAttachment: vi.fn().mockResolvedValue({
          filename: 'report.pdf',
          mimeType: 'application/pdf',
          size: 3,
          contentBase64: Buffer.from('pdf').toString('base64'),
        }),
      } as unknown as ImapService;
    }

    it('does not include original attachments by default', async () => {
      const imapService = createMockImapServiceWithEmail([
        { filename: 'report.pdf', mimeType: 'application/pdf', size: 3 },
      ]);
      service = new SmtpService(connections, rateLimiter, imapService);

      await service.forwardEmail('test', { emailId: '1', to: ['dest@example.com'] });

      const call = transport.sendMail.mock.calls[0][0];
      expect(call.attachments).toEqual([]);
      expect(imapService.downloadAttachment).not.toHaveBeenCalled();
    });

    it('re-attaches original attachments when includeOriginalAttachments is true', async () => {
      const imapService = createMockImapServiceWithEmail([
        { filename: 'report.pdf', mimeType: 'application/pdf', size: 3 },
      ]);
      service = new SmtpService(connections, rateLimiter, imapService);

      await service.forwardEmail('test', {
        emailId: '1',
        to: ['dest@example.com'],
        includeOriginalAttachments: true,
      });

      const call = transport.sendMail.mock.calls[0][0];
      expect(call.attachments).toEqual([
        { filename: 'report.pdf', content: Buffer.from('pdf'), contentType: 'application/pdf' },
      ]);
    });

    it('combines original and user-supplied attachments', async () => {
      const imapService = createMockImapServiceWithEmail([
        { filename: 'report.pdf', mimeType: 'application/pdf', size: 3 },
      ]);
      service = new SmtpService(connections, rateLimiter, imapService);

      await service.forwardEmail('test', {
        emailId: '1',
        to: ['dest@example.com'],
        includeOriginalAttachments: true,
        attachments: [{ filename: 'note.txt', content: Buffer.from('hi').toString('base64') }],
      });

      const call = transport.sendMail.mock.calls[0][0];
      expect(call.attachments).toHaveLength(2);
      expect(call.attachments[0].filename).toBe('report.pdf');
      expect(call.attachments[1].filename).toBe('note.txt');
    });
  });

  describe('sendDraft', () => {
    function createMockImapServiceWithDraft(
      attachments: { filename: string; mimeType: string; size: number }[],
    ) {
      return {
        fetchDraft: vi.fn().mockResolvedValue({
          email: {
            id: '5',
            subject: 'Draft subject',
            to: [{ address: 'dest@example.com' }],
            bodyText: 'Draft body',
            attachments,
          },
          mailbox: 'Drafts',
        }),
        downloadAttachment: vi.fn().mockResolvedValue({
          filename: 'invoice.pdf',
          mimeType: 'application/pdf',
          size: 3,
          contentBase64: Buffer.from('pdf').toString('base64'),
        }),
        deleteDraft: vi.fn().mockResolvedValue(undefined),
      } as unknown as ImapService;
    }

    it('carries the draft attachments over when sending', async () => {
      const imapService = createMockImapServiceWithDraft([
        { filename: 'invoice.pdf', mimeType: 'application/pdf', size: 3 },
      ]);
      service = new SmtpService(connections, rateLimiter, imapService);

      await service.sendDraft('test', 5);

      const call = transport.sendMail.mock.calls[0][0];
      expect(call.attachments).toEqual([
        { filename: 'invoice.pdf', content: Buffer.from('pdf'), contentType: 'application/pdf' },
      ]);
      expect(imapService.deleteDraft).toHaveBeenCalledWith('test', 5, 'Drafts');
    });

    it('sends with no attachments when the draft has none', async () => {
      const imapService = createMockImapServiceWithDraft([]);
      service = new SmtpService(connections, rateLimiter, imapService);

      await service.sendDraft('test', 5);

      const call = transport.sendMail.mock.calls[0][0];
      expect(call.attachments).toEqual([]);
    });
  });
});
