import type { TestServices } from './helpers/index.js';
import {
  buildSecondTestAccount,
  buildTestAccount,
  createTestServices,
  TEST_ACCOUNT_NAME,
  waitForDelivery,
} from './helpers/index.js';

describe('Email Send Operations', () => {
  let services: TestServices;
  const account = buildTestAccount();
  const account2 = buildSecondTestAccount();

  beforeAll(async () => {
    services = createTestServices(account, account2);
  });

  afterAll(async () => {
    await services.connections.closeAll();
  });

  // ---------------------------------------------------------------------------
  // send_email
  // ---------------------------------------------------------------------------

  describe('sendEmail', () => {
    it('should send a plain text email', async () => {
      const result = await services.smtpService.sendEmail(TEST_ACCOUNT_NAME, {
        to: ['bob@localhost'],
        subject: 'Plain text test',
        body: 'Hello Bob, this is a test.',
      });

      expect(result).toBeDefined();
      expect(result.messageId).toBeTruthy();
    });

    it('should send an HTML email', async () => {
      const result = await services.smtpService.sendEmail(TEST_ACCOUNT_NAME, {
        to: ['bob@localhost'],
        subject: 'HTML test',
        body: '<h1>Hello</h1><p>HTML email</p>',
        html: true,
      });

      expect(result.messageId).toBeTruthy();
    });

    it('should send with CC recipients', async () => {
      const result = await services.smtpService.sendEmail(TEST_ACCOUNT_NAME, {
        to: ['bob@localhost'],
        cc: ['alice@localhost'],
        subject: 'CC test',
        body: 'Email with CC',
      });

      expect(result.messageId).toBeTruthy();
    });

    it('should deliver email to recipient inbox', async () => {
      await services.smtpService.sendEmail(TEST_ACCOUNT_NAME, {
        to: ['bob@localhost'],
        subject: 'Delivery verification test',
        body: 'This should appear in Bob inbox',
      });

      await waitForDelivery();

      const result = await services.imapService.listEmails('integration-2', {
        subject: 'Delivery verification test',
      });

      expect(result.items.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ---------------------------------------------------------------------------
  // reply_email
  // ---------------------------------------------------------------------------

  describe('replyToEmail', () => {
    it('should reply to an email with proper threading', async () => {
      // Send original email from bob to test
      await services.smtpService.sendEmail('integration-2', {
        to: ['test@localhost'],
        subject: 'Reply test original',
        body: 'Please reply to this.',
      });

      await waitForDelivery();

      // Find the email in test's inbox
      const list = await services.imapService.listEmails(TEST_ACCOUNT_NAME, {
        subject: 'Reply test original',
      });
      expect(list.items.length).toBeGreaterThanOrEqual(1);

      const emailId = list.items[0].id;

      // Reply
      const reply = await services.smtpService.replyToEmail(TEST_ACCOUNT_NAME, {
        emailId,
        body: 'This is my reply.',
      });

      expect(reply.messageId).toBeTruthy();
    });
  });

  // ---------------------------------------------------------------------------
  // forward_email
  // ---------------------------------------------------------------------------

  describe('forwardEmail', () => {
    it('should forward an email to new recipients', async () => {
      // Send original
      await services.smtpService.sendEmail('integration-2', {
        to: ['test@localhost'],
        subject: 'Forward test original',
        body: 'Please forward this.',
      });

      await waitForDelivery();

      const list = await services.imapService.listEmails(TEST_ACCOUNT_NAME, {
        subject: 'Forward test original',
      });
      expect(list.items.length).toBeGreaterThanOrEqual(1);

      const emailId = list.items[0].id;

      // Forward
      const fwd = await services.smtpService.forwardEmail(TEST_ACCOUNT_NAME, {
        emailId,
        to: ['alice@localhost'],
        body: 'FYI, see below.',
      });

      expect(fwd.messageId).toBeTruthy();
    });
  });
});
