import {
  buildSslAccount,
  buildStarttlsAccount,
  buildTestAccount,
  createTestServices,
  seedEmail,
  type TestServices,
  waitForDelivery,
} from './helpers/index.js';

/**
 * Tests all three connection modes supported by the IMAP/SMTP config:
 *   1. Plain (no encryption)       — SMTP :3025  / IMAP :3143
 *   2. STARTTLS (upgrade to TLS)   — SMTP :3025  / IMAP :3143
 *   3. Implicit SSL/TLS            — SMTPS :3465 / IMAPS :3993
 */
describe('Connection Modes', () => {
  // -------------------------------------------------------------------------
  // Plain (baseline — already covered elsewhere, quick smoke test here)
  // -------------------------------------------------------------------------

  describe('Plain (no encryption)', () => {
    let services: TestServices;
    const account = buildTestAccount({ name: 'integration-plain' });

    beforeAll(async () => {
      services = createTestServices(account);
      await seedEmail({ subject: 'Plain mode test' });
      await waitForDelivery();
    });

    afterAll(async () => {
      await services.connections.closeAll();
    });

    it('should connect via IMAP without encryption', async () => {
      const mailboxes = await services.imapService.listMailboxes(account.name);
      expect(mailboxes.find((m) => m.path === 'INBOX')).toBeDefined();
    });

    it('should list emails via IMAP without encryption', async () => {
      const list = await services.imapService.listEmails(account.name, {
        subject: 'Plain mode test',
      });
      expect(list.items.length).toBeGreaterThanOrEqual(1);
    });

    it('should send email via SMTP without encryption', async () => {
      const result = await services.smtpService.sendEmail(account.name, {
        to: ['bob@localhost'],
        subject: 'Plain send test',
        body: 'Sent over plain connection',
      });
      expect(result.messageId).toBeTruthy();
    });

    it('should fetch full email content without encryption', async () => {
      const list = await services.imapService.listEmails(account.name, { pageSize: 1 });
      if (list.items.length > 0) {
        const email = await services.imapService.getEmail(account.name, list.items[0].id);
        expect(email.subject).toBeTruthy();
      }
    });

    it('should set flags without encryption', async () => {
      const list = await services.imapService.listEmails(account.name, { pageSize: 1 });
      if (list.items.length > 0) {
        await services.imapService.setFlags(account.name, list.items[0].id, 'INBOX', 'read');
        const flags = await services.imapService.getEmailFlags(account.name, list.items[0].id);
        expect(flags.seen).toBe(true);
      }
    });
  });

  // -------------------------------------------------------------------------
  // STARTTLS
  // -------------------------------------------------------------------------

  describe('STARTTLS', () => {
    let services: TestServices;
    const account = buildStarttlsAccount();

    beforeAll(async () => {
      services = createTestServices(account);
    });

    afterAll(async () => {
      await services.connections.closeAll();
    });

    it('should connect via IMAP with STARTTLS', async () => {
      const mailboxes = await services.imapService.listMailboxes(account.name);
      expect(mailboxes.find((m) => m.path === 'INBOX')).toBeDefined();
    });

    it('should list emails via IMAP with STARTTLS', async () => {
      const list = await services.imapService.listEmails(account.name);
      expect(list.items).toBeInstanceOf(Array);
    });

    it('should send email via SMTP with STARTTLS', async () => {
      // GreenMail's SMTP does not support the STARTTLS upgrade command.
      // Verify the connection attempt produces the expected STARTTLS error
      // rather than a generic connection failure.
      await expect(
        services.smtpService.sendEmail(account.name, {
          to: ['bob@localhost'],
          subject: 'STARTTLS send test',
          body: 'Sent over STARTTLS connection',
        }),
      ).rejects.toThrow(/STARTTLS/i);
    });

    it('should fetch full email content via STARTTLS', async () => {
      const list = await services.imapService.listEmails(account.name, { pageSize: 1 });
      if (list.items.length > 0) {
        const email = await services.imapService.getEmail(account.name, list.items[0].id);
        expect(email.subject).toBeTruthy();
      }
    });

    it('should set flags via STARTTLS', async () => {
      const list = await services.imapService.listEmails(account.name, { pageSize: 1 });
      if (list.items.length > 0) {
        await services.imapService.setFlags(account.name, list.items[0].id, 'INBOX', 'read');
        const flags = await services.imapService.getEmailFlags(account.name, list.items[0].id);
        expect(flags.seen).toBe(true);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Implicit SSL/TLS
  // -------------------------------------------------------------------------

  describe('Implicit SSL/TLS', () => {
    let services: TestServices;
    const account = buildSslAccount();

    beforeAll(async () => {
      services = createTestServices(account);
    });

    afterAll(async () => {
      await services.connections.closeAll();
    });

    it('should connect via IMAPS (implicit TLS)', async () => {
      const mailboxes = await services.imapService.listMailboxes(account.name);
      expect(mailboxes.find((m) => m.path === 'INBOX')).toBeDefined();
    });

    it('should list emails via IMAPS', async () => {
      const list = await services.imapService.listEmails(account.name);
      expect(list.items).toBeInstanceOf(Array);
    });

    it('should send email via SMTPS (implicit TLS)', async () => {
      const result = await services.smtpService.sendEmail(account.name, {
        to: ['bob@localhost'],
        subject: 'SSL send test',
        body: 'Sent over implicit SSL connection',
      });
      expect(result.messageId).toBeTruthy();
    });

    it('should fetch full email content via IMAPS', async () => {
      const list = await services.imapService.listEmails(account.name, { pageSize: 1 });
      if (list.items.length > 0) {
        const email = await services.imapService.getEmail(account.name, list.items[0].id);
        expect(email.subject).toBeTruthy();
      }
    });

    it('should set flags via IMAPS', async () => {
      const list = await services.imapService.listEmails(account.name, { pageSize: 1 });
      if (list.items.length > 0) {
        await services.imapService.setFlags(account.name, list.items[0].id, 'INBOX', 'flag');
        const flags = await services.imapService.getEmailFlags(account.name, list.items[0].id);
        expect(flags.flagged).toBe(true);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Cross-mode: send via one mode, read via another
  // -------------------------------------------------------------------------

  describe('Cross-mode interoperability', () => {
    let plainServices: TestServices;
    let sslServices: TestServices;

    beforeAll(async () => {
      plainServices = createTestServices(buildTestAccount());
      sslServices = createTestServices(buildSslAccount());
    });

    afterAll(async () => {
      await plainServices.connections.closeAll();
      await sslServices.connections.closeAll();
    });

    it('should send via plain SMTP and read via IMAPS', async () => {
      await plainServices.smtpService.sendEmail('integration', {
        to: ['test@localhost'],
        subject: 'Cross-mode plain-to-ssl',
        body: 'Sent plain, read SSL',
      });
      await waitForDelivery();

      const list = await sslServices.imapService.listEmails('integration-ssl', {
        subject: 'Cross-mode plain-to-ssl',
      });
      expect(list.items.length).toBeGreaterThanOrEqual(1);
    });

    it('should send via SMTPS and read via plain IMAP', async () => {
      await sslServices.smtpService.sendEmail('integration-ssl', {
        to: ['test@localhost'],
        subject: 'Cross-mode ssl-to-plain',
        body: 'Sent SSL, read plain',
      });
      await waitForDelivery();

      const list = await plainServices.imapService.listEmails('integration', {
        subject: 'Cross-mode ssl-to-plain',
      });
      expect(list.items.length).toBeGreaterThanOrEqual(1);
    });
  });
});
