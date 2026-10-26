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
        sentCopy: { kind: 'skipped' },
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

    it('passes threading headers to the transport when given', async () => {
      await service.sendEmail('test', {
        to: ['a@example.com'],
        subject: 'Re: thread',
        body: 'scheduled reply',
        inReplyTo: '<orig@x>',
        references: ['<root@x>', '<orig@x>'],
      });

      expect(transport.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          inReplyTo: '<orig@x>',
          references: '<root@x> <orig@x>',
        }),
      );
    });

    it('sends HTML with a generated plain-text alternative', async () => {
      await service.sendEmail('test', {
        to: ['a@example.com'],
        subject: 'HTML Test',
        body: '<h1>Hello</h1>',
        html: true,
      });

      // nodemailer 10 removed text:'auto', so the service generates the
      // text/plain alternative itself — HTML mail goes out as
      // multipart/alternative, not as a single text/html part.
      const call = transport.sendMail.mock.calls[0]![0];
      expect(call.html).toBe('<h1>Hello</h1>');
      expect(call.text).toBe('Hello');
    });
  });

  describe('sendDraft', () => {
    function setupDraft() {
      const imap = {
        fetchDraft: vi.fn().mockResolvedValue({
          email: {
            to: [{ address: 'a@b.c' }],
            bcc: [{ address: 'hidden@b.c' }],
            subject: 'Draft',
            bodyHtml: '<img src="cid:logo">',
            attachments: [
              { filename: 'same.png', partId: '2', contentId: 'logo', inline: true },
              { filename: 'same.png', partId: '3', inline: false },
            ],
          },
          mailbox: 'Custom Drafts',
        }),
        downloadAttachment: vi.fn().mockResolvedValue({
          filename: 'same.png',
          mimeType: 'image/png',
          contentBase64: 'YWJj',
        }),
        deleteDraft: vi.fn().mockResolvedValue(undefined),
      };
      service = new SmtpService(connections, rateLimiter, imap as unknown as ImapService);
      return imap;
    }

    it('preserves BCC, duplicate-named attachments and inline CIDs before removing the draft', async () => {
      const imap = setupDraft();
      const result = await service.sendDraft('test', 7);
      expect(transport.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          bcc: 'hidden@b.c',
          attachments: [
            expect.objectContaining({
              content: Buffer.from('abc'),
              cid: 'logo',
              contentDisposition: 'inline',
            }),
            expect.objectContaining({
              content: Buffer.from('abc'),
              contentDisposition: 'attachment',
            }),
          ],
        }),
      );
      expect(imap.downloadAttachment).toHaveBeenNthCalledWith(
        1,
        'test',
        '7',
        'Custom Drafts',
        { partId: '2' },
        25 * 1024 * 1024,
      );
      expect(imap.downloadAttachment).toHaveBeenNthCalledWith(
        2,
        'test',
        '7',
        'Custom Drafts',
        { partId: '3' },
        25 * 1024 * 1024 - 3,
      );
      expect(result.draftCleanup).toEqual({ kind: 'removed' });
      expect(imap.deleteDraft).toHaveBeenCalledWith('test', 7, 'Custom Drafts');
    });

    it('does not send or delete a draft when a part cannot be downloaded', async () => {
      const imap = setupDraft();
      imap.downloadAttachment.mockRejectedValue(new Error('part exceeds limit'));
      await expect(service.sendDraft('test', 7)).rejects.toThrow('part exceeds limit');
      expect(transport.sendMail).not.toHaveBeenCalled();
      expect(imap.deleteDraft).not.toHaveBeenCalled();
    });

    it('reports SMTP success separately from cleanup failure', async () => {
      const imap = setupDraft();
      imap.deleteDraft.mockRejectedValue(new Error('IMAP unavailable'));
      await expect(service.sendDraft('test', 7)).resolves.toMatchObject({
        status: 'sent',
        draftCleanup: { kind: 'failed', error: 'IMAP unavailable' },
      });
      expect(transport.sendMail).toHaveBeenCalledTimes(1);
    });

    it('keeps the original draft when SMTP fails', async () => {
      const imap = setupDraft();
      transport.sendMail.mockRejectedValue(new Error('SMTP unavailable'));
      await expect(service.sendDraft('test', 7)).rejects.toThrow('SMTP unavailable');
      expect(imap.deleteDraft).not.toHaveBeenCalled();
    });

    it('sends both parts for an HTML draft', async () => {
      const imap = {
        fetchDraft: vi.fn().mockResolvedValue({
          email: {
            to: [{ address: 'a@b.c' }],
            subject: 'Draft',
            bodyHtml: '<p>drafted <b>text</b></p>',
            references: [],
          },
          mailbox: 'Drafts',
        }),
        deleteDraft: vi.fn().mockResolvedValue(undefined),
      } as unknown as ImapService;
      service = new SmtpService(connections, rateLimiter, imap);

      await service.sendDraft('test', 7);

      const call = transport.sendMail.mock.calls[0]![0];
      expect(call.html).toBe('<p>drafted <b>text</b></p>');
      expect(call.text).toBe('drafted text');
    });
  });
});

// SMTP delivers but files nothing. Gmail and Outlook capture sent mail
// server-side, so doing this unasked would show those users two copies —
// hence opt-in, and hence the default-off test below.
describe('saving a copy to the Sent folder', () => {
  function withImap(saveToSent: boolean) {
    const transport = createMockTransport();
    const connections = createMockConnectionManager(transport);
    const imap = {
      appendToSent: vi.fn().mockResolvedValue({ kind: 'filed', path: 'Sent' }),
      fetchDraft: vi.fn(),
      deleteDraft: vi.fn().mockResolvedValue(undefined),
    };
    const service = new SmtpService(
      connections,
      createMockRateLimiter(true),
      imap as unknown as ImapService,
      { saveToSent },
    );
    return { service, imap, transport };
  }

  const mail = { to: ['a@b.c'], subject: 'Quarterly', body: 'text' };

  it('does not touch IMAP when the setting is off', async () => {
    const { service, imap } = withImap(false);
    await service.sendEmail('test', mail);
    expect(imap.appendToSent).not.toHaveBeenCalled();
  });

  it('appends a copy carrying the Message-ID the server accepted', async () => {
    const { service, imap } = withImap(true);

    const result = await service.sendEmail('test', mail);

    expect(imap.appendToSent).toHaveBeenCalledTimes(1);
    const [account, raw] = imap.appendToSent.mock.calls[0]!;
    expect(account).toBe('test');
    const message = (raw as Buffer).toString('utf-8');
    // The copy must be the same message, not a lookalike: same id, so a reply
    // to it threads against what actually went out.
    expect(message).toContain(result.messageId);
    expect(message).toContain('Subject: Quarterly');
    expect(message).toContain('a@b.c');
    expect(result.sentCopy).toEqual({ kind: 'filed', path: 'Sent' });
  });

  // Documented limitation, pinned so it cannot change silently: nodemailer's
  // composer strips Bcc unconditionally — correct for the wire, and it also
  // strips it from a custom `headers` entry, so a filed copy cannot carry the
  // blind-copy list without hand-injecting a header into built bytes. That
  // would add header-injection surface to the send path, which is not worth a
  // convenience on an opt-in feature.
  it('omits Bcc from the filed copy, as the composer strips it', async () => {
    const { service, imap } = withImap(true);
    await service.sendEmail('test', { ...mail, bcc: ['hidden@b.c'] });
    const message = (imap.appendToSent.mock.calls[0]![1] as Buffer).toString('utf-8');
    expect(message).not.toContain('hidden@b.c');
    // The rest of the message is still the message that was sent.
    expect(message).toContain('Subject: Quarterly');
  });

  // The mail has already left. Failing the call now would tell the user the
  // send failed and invite a duplicate send.
  it('reports the send as sent even when filing the copy fails', async () => {
    const { service, imap } = withImap(true);
    imap.appendToSent.mockRejectedValue(new Error('NO [TRYCREATE] no Sent folder'));

    const result = await service.sendEmail('test', mail);

    expect(result.status).toBe('sent');
    expect(result.sentCopy).toEqual({
      kind: 'failed',
      error: expect.stringContaining('TRYCREATE'),
    });
  });

  it('files a copy for replies too', async () => {
    const { service, imap } = withImap(true);
    imap.fetchDraft = vi.fn();
    const imapWithOriginal = imap as unknown as Record<string, unknown>;
    imapWithOriginal.getEmail = vi.fn().mockResolvedValue({
      subject: 'Question',
      messageId: '<orig@x>',
      from: { address: 'them@x.test' },
      to: [{ address: 'test@example.com' }],
      cc: [],
      references: [],
      date: 'Mon, 25 May 2026 16:11:00 +0200',
      bodyText: 'What do you think?',
    });

    await service.replyToEmail('test', { emailId: '7', body: 'answer' });

    expect(imap.appendToSent).toHaveBeenCalledTimes(1);
    const [, raw] = imap.appendToSent.mock.calls[0]!;
    expect((raw as Buffer).toString('utf-8')).toContain('In-Reply-To: <orig@x>');
  });

  function withDraft(imap: ReturnType<typeof withImap>['imap']) {
    imap.fetchDraft = vi.fn().mockResolvedValue({
      email: { to: [{ address: 'a@b.c' }], subject: 'Draft', bodyText: 'text', references: [] },
      mailbox: 'Drafts',
    });
  }

  // A failed APPEND plus an unconditional draft delete left zero copies of
  // the message anywhere: not in Sent (the APPEND failed) and not in Drafts
  // (deleted anyway) — even though the send itself succeeded.
  it('keeps the draft when the Sent-copy APPEND fails', async () => {
    const { service, imap } = withImap(true);
    withDraft(imap);
    imap.appendToSent.mockRejectedValue(new Error('NO [TRYCREATE] no Sent folder'));

    await service.sendDraft('test', 7);

    expect(imap.deleteDraft).not.toHaveBeenCalled();
  });

  it('still deletes the draft when the Sent-copy is only skipped on purpose', async () => {
    const { service, imap } = withImap(true);
    withDraft(imap);
    imap.appendToSent.mockResolvedValue({ kind: 'skipped' });

    await service.sendDraft('test', 7);

    expect(imap.deleteDraft).toHaveBeenCalledTimes(1);
  });
});

describe('outbound attachments', () => {
  let transport: ReturnType<typeof createMockTransport>;
  let connections: ReturnType<typeof createMockConnectionManager>;

  function service(imap: ImapService = createMockImapService()) {
    transport = createMockTransport();
    connections = createMockConnectionManager(transport);
    return new SmtpService(connections, createMockRateLimiter(), imap);
  }

  it('sendEmail hands prepared attachments to the transport as file paths', async () => {
    const svc = service();
    await svc.sendEmail('test', {
      to: ['a@b.c'],
      subject: 's',
      body: 'b',
      attachments: [{ filename: 'report.pdf', path: '/tmp/report.pdf', size: 10 }],
    });

    expect(transport.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        attachments: [{ filename: 'report.pdf', path: '/tmp/report.pdf' }],
      }),
    );
  });

  it('sendEmail turns a cid attachment into an inline related part', async () => {
    const svc = service();
    await svc.sendEmail('test', {
      to: ['a@b.c'],
      subject: 's',
      body: '<p>Logo: <img src="cid:logo@x"></p>',
      html: true,
      attachments: [
        {
          filename: 'logo.png',
          path: '/tmp/logo.png',
          size: 10,
          cid: 'logo@x',
          contentType: 'image/png',
        },
      ],
    });

    expect(transport.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        attachments: [
          {
            filename: 'logo.png',
            path: '/tmp/logo.png',
            cid: 'logo@x',
            contentDisposition: 'inline',
            contentType: 'image/png',
          },
        ],
      }),
    );
  });

  it('sendEmail omits the attachments key entirely when none are given', async () => {
    const svc = service();
    await svc.sendEmail('test', { to: ['a@b.c'], subject: 's', body: 'b' });

    const payload = transport.sendMail.mock.calls[0]![0];
    expect('attachments' in payload).toBe(false);
  });

  it('forwardEmail re-attaches the original attachments by default', async () => {
    const imap = {
      getEmail: vi.fn().mockResolvedValue({
        subject: 'Orig',
        from: { address: 'x@y.z' },
        to: [{ address: 'me@y.z' }],
        date: '2026-01-01',
        bodyText: 'hello',
        attachments: [{ filename: 'invoice.pdf', mimeType: 'application/pdf', size: 3 }],
      }),
      downloadAttachment: vi.fn().mockResolvedValue({
        filename: 'invoice.pdf',
        mimeType: 'application/pdf',
        size: 3,
        contentBase64: Buffer.from('abc').toString('base64'),
      }),
    } as unknown as ImapService;

    const svc = service(imap);
    await svc.forwardEmail('test', { emailId: '1', to: ['a@b.c'] });

    expect(imap.downloadAttachment).toHaveBeenCalledWith(
      'test',
      '1',
      'INBOX',
      'invoice.pdf',
      expect.any(Number),
    );
    const payload = transport.sendMail.mock.calls[0]![0];
    expect(payload.attachments).toEqual([
      {
        filename: 'invoice.pdf',
        content: Buffer.from('abc'),
        contentType: 'application/pdf',
      },
    ]);
  });

  it('forwardEmail converts an HTML-only original and quotes it', async () => {
    const imap = {
      getEmail: vi.fn().mockResolvedValue({
        subject: 'Orig',
        from: { address: 'x@y.z' },
        to: [{ address: 'me@y.z' }],
        date: '2026-01-01',
        bodyText: undefined,
        bodyHtml: '<p>Hello <b>world</b></p><p>second line</p>',
        attachments: [],
      }),
    } as unknown as ImapService;

    const svc = service(imap);
    await svc.forwardEmail('test', { emailId: '1', to: ['a@b.c'], body: 'FYI' });

    const payload = transport.sendMail.mock.calls[0]![0];
    // 165/169 real messages are HTML-only; the old text ?? html fallback
    // stuffed raw markup into a text/plain part.
    expect(payload.text).not.toContain('<p>');
    expect(payload.text).toContain('FYI');
    expect(payload.text).toContain('---------- Forwarded message ----------');
    expect(payload.text).toContain('> Hello world');
    expect(payload.text).toContain('> second line');
    expect(payload.html).toBeUndefined();
  });

  it('forwardEmail html=true carries the original HTML in a blockquote', async () => {
    const imap = {
      getEmail: vi.fn().mockResolvedValue({
        subject: 'Orig',
        from: { address: 'x@y.z' },
        to: [{ address: 'me@y.z' }],
        date: '2026-01-01',
        bodyText: undefined,
        bodyHtml: '<p>original rich content</p>',
        attachments: [],
      }),
    } as unknown as ImapService;

    const svc = service(imap);
    await svc.forwardEmail('test', { emailId: '1', to: ['a@b.c'], body: 'note', html: true });

    const payload = transport.sendMail.mock.calls[0]![0];
    expect(payload.html).toContain('note');
    expect(payload.html).toContain('<blockquote');
    expect(payload.html).toContain('<p>original rich content</p>');
    // The text alternative still ships, quoted and markup-free.
    expect(payload.text).toContain('> original rich content');
    expect(payload.text).not.toContain('<p>');
  });

  it('forwardEmail neutralises line breaks in the quoted envelope fields', async () => {
    // Envelope subjects and display names arrive RFC 2047-decoded with no
    // newline stripping, so a crafted subject could forge a "From:" line in
    // the forward header block — which is NOT "> "-quoted.
    const imap = {
      getEmail: vi.fn().mockResolvedValue({
        subject: 'Invoice\r\nFrom: ceo@bank.test',
        from: { name: 'X\r\nTo: victim@x.test', address: 'x@y.z' },
        to: [{ address: 'me@y.z' }],
        date: '2026-01-01',
        bodyText: 'hello',
        attachments: [],
      }),
    } as unknown as ImapService;

    const svc = service(imap);
    await svc.forwardEmail('test', { emailId: '1', to: ['a@b.c'] });

    const { text, subject } = transport.sendMail.mock.calls[0]![0];
    const headerBlock = text.slice(0, text.indexOf('> '));
    expect(headerBlock).not.toMatch(/^From: ceo@bank\.test/m);
    expect(headerBlock).not.toMatch(/^To: victim@x\.test/m);
    expect(subject).not.toContain('\n');
  });

  it('forwardEmail carries an inline file the HTML never references', async () => {
    // Apple Mail ships user-inserted photos as `inline; filename=...` with a
    // Content-ID, and some mailers ship invoices that way too. Skipping every
    // inline part silently dropped real user files from forwards.
    const imap = {
      getEmail: vi.fn().mockResolvedValue({
        subject: 'Orig',
        from: { address: 'x@y.z' },
        to: [{ address: 'me@y.z' }],
        date: '2026-01-01',
        bodyText: 'see photo',
        bodyHtml: '<p>see photo</p>',
        attachments: [
          {
            filename: 'IMG_1234.jpg',
            mimeType: 'image/jpeg',
            size: 3,
            partId: '2',
            contentId: 'photo@mail',
            inline: true,
          },
        ],
      }),
      downloadAttachment: vi.fn().mockResolvedValue({
        filename: 'IMG_1234.jpg',
        mimeType: 'image/jpeg',
        size: 3,
        contentBase64: Buffer.from('jpg').toString('base64'),
      }),
    } as unknown as ImapService;

    const svc = service(imap);
    await svc.forwardEmail('test', { emailId: '1', to: ['a@b.c'] });

    const payload = transport.sendMail.mock.calls[0]![0];
    expect(payload.attachments).toHaveLength(1);
    expect(payload.attachments[0].filename).toBe('IMG_1234.jpg');
  });

  it('forwardEmail keeps cid parts the forwarded HTML embeds, as inline', async () => {
    const imap = {
      getEmail: vi.fn().mockResolvedValue({
        subject: 'Orig',
        from: { address: 'x@y.z' },
        to: [{ address: 'me@y.z' }],
        date: '2026-01-01',
        bodyHtml: '<p>Logo <img src="cid:logo@x"></p>',
        attachments: [
          {
            filename: 'logo.png',
            mimeType: 'image/png',
            size: 3,
            partId: '2',
            contentId: 'logo@x',
            inline: true,
          },
        ],
      }),
      downloadAttachment: vi.fn().mockResolvedValue({
        filename: 'logo.png',
        mimeType: 'image/png',
        size: 3,
        contentBase64: Buffer.from('png').toString('base64'),
      }),
    } as unknown as ImapService;

    const svc = service(imap);
    await svc.forwardEmail('test', { emailId: '1', to: ['a@b.c'], html: true });

    // An html forward embeds the original markup verbatim, so the parts its
    // <img src="cid:..."> points at have to travel with it or the images break.
    const payload = transport.sendMail.mock.calls[0]![0];
    expect(payload.attachments).toEqual([
      expect.objectContaining({ cid: 'logo@x', contentDisposition: 'inline' }),
    ]);
  });

  it('forwardEmail drops an embedded cid part when forwarding as text only', async () => {
    const imap = {
      getEmail: vi.fn().mockResolvedValue({
        subject: 'Orig',
        from: { address: 'x@y.z' },
        to: [{ address: 'me@y.z' }],
        date: '2026-01-01',
        bodyHtml: '<p>Logo <img src="cid:logo@x"></p>',
        attachments: [
          {
            filename: 'logo.png',
            mimeType: 'image/png',
            size: 3,
            partId: '2',
            contentId: 'logo@x',
            inline: true,
          },
        ],
      }),
      downloadAttachment: vi.fn(),
    } as unknown as ImapService;

    const svc = service(imap);
    await svc.forwardEmail('test', { emailId: '1', to: ['a@b.c'] });

    // Nothing references it once the body is plain text — re-attaching would
    // turn layout images into stray files.
    expect(imap.downloadAttachment).not.toHaveBeenCalled();
    const payload = transport.sendMail.mock.calls[0]![0];
    expect('attachments' in payload).toBe(false);
  });

  it('forwardEmail skips attachments when includeAttachments is false', async () => {
    const imap = {
      getEmail: vi.fn().mockResolvedValue({
        subject: 'Orig',
        from: { address: 'x@y.z' },
        to: [{ address: 'me@y.z' }],
        date: '2026-01-01',
        bodyText: 'hello',
        attachments: [{ filename: 'invoice.pdf', mimeType: 'application/pdf', size: 3 }],
      }),
      downloadAttachment: vi.fn(),
    } as unknown as ImapService;

    const svc = service(imap);
    await svc.forwardEmail('test', { emailId: '1', to: ['a@b.c'], includeAttachments: false });

    expect(imap.downloadAttachment).not.toHaveBeenCalled();
    const payload = transport.sendMail.mock.calls[0]![0];
    expect('attachments' in payload).toBe(false);
  });
});

describe('reply attachments', () => {
  it('replyToEmail hands prepared attachments to the transport', async () => {
    const imap = {
      getEmail: vi.fn().mockResolvedValue({
        subject: 'Orig',
        from: { address: 'x@y.z' },
        to: [{ address: 'me@y.z' }],
        date: '2026-01-01',
        bodyText: 'hello',
        messageId: '<m1@y.z>',
        references: [],
        attachments: [],
      }),
    } as unknown as ImapService;
    const transport = createMockTransport();
    const connections = createMockConnectionManager(transport);
    const svc = new SmtpService(connections, createMockRateLimiter(), imap);

    await svc.replyToEmail('test', {
      emailId: '1',
      body: 'r',
      attachments: [{ filename: 'a.txt', path: '/tmp/a.txt', size: 1 }],
    });

    expect(transport.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({ attachments: [{ filename: 'a.txt', path: '/tmp/a.txt' }] }),
    );
  });
});

describe('replyToEmail quote_original', () => {
  function makeOriginal(overrides: Record<string, unknown> = {}) {
    return {
      id: '42',
      subject: 'Project update',
      from: { name: 'Alex', address: 'alex@example.com' },
      to: [{ address: 'test@example.com' }],
      cc: [],
      date: 'Mon, 25 May 2026 16:11:00 +0200',
      messageId: '<orig-42@example.com>',
      references: ['<root@example.com>'],
      bodyText: 'Where are we on the launch?',
      attachments: [],
      ...overrides,
    };
  }

  function setup(original: Record<string, unknown>) {
    const imap = { getEmail: vi.fn().mockResolvedValue(original) } as unknown as ImapService;
    const transport = createMockTransport();
    const connections = createMockConnectionManager(transport);
    const service = new SmtpService(connections, createMockRateLimiter(), imap);
    return { service, transport };
  }

  it('appends quoted original below text reply by default', async () => {
    const { service, transport } = setup(makeOriginal());

    await service.replyToEmail('test', { emailId: '42', body: 'On it tomorrow.' });

    const call = transport.sendMail.mock.calls[0]![0];
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
    const { service, transport } = setup(
      makeOriginal({ bodyHtml: '<p>Where are we?</p>', bodyText: undefined }),
    );

    await service.replyToEmail('test', {
      emailId: '42',
      body: '<p>On it tomorrow.</p>',
      html: true,
    });

    const call = transport.sendMail.mock.calls[0]![0];
    expect(call.html).toContain('<p>On it tomorrow.</p>');
    expect(call.html).toContain('<blockquote type="cite"');
    // The original is quoted as stripped, escaped text in a <pre>, never as
    // raw HTML — embedding it unsanitized would let an unbalanced tag break
    // out of the quote boundary (see utils/quote.ts).
    expect(call.html).toContain('<pre');
    expect(call.html).toContain('Where are we?');
    // stripHtml derives the plain-text alternative from the quoted HTML —
    // it is never undefined, since nodemailer 10 no longer generates one.
    expect(call.text).toContain('On it tomorrow.');
    expect(call.text).toContain('> Where are we?');
  });

  it('does not append a quoted block when quoteOriginal=false', async () => {
    const { service, transport } = setup(makeOriginal());

    await service.replyToEmail('test', {
      emailId: '42',
      body: 'On it tomorrow.',
      quoteOriginal: false,
    });

    const call = transport.sendMail.mock.calls[0]![0];
    expect(call.text).toBe('On it tomorrow.');
    expect(call.text).not.toContain('wrote:');
    expect(call.text).not.toContain('>');
  });
});
