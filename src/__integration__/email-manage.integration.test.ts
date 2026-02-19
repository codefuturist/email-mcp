import type { TestServices } from './helpers/index.js';
import {
  buildTestAccount,
  createTestServices,
  seedEmail,
  seedEmails,
  TEST_ACCOUNT_NAME,
  waitForDelivery,
} from './helpers/index.js';

describe('Email Management Operations', () => {
  let services: TestServices;

  beforeAll(async () => {
    services = createTestServices(buildTestAccount());
    // GreenMail doesn't auto-create Trash — create it for delete tests
    try {
      await services.imapService.createMailbox(TEST_ACCOUNT_NAME, 'Trash');
    } catch {
      // Already exists
    }
  });

  afterAll(async () => {
    await services.connections.closeAll();
  });

  // ---------------------------------------------------------------------------
  // setFlags (mark_email)
  // ---------------------------------------------------------------------------

  describe('setFlags', () => {
    it('should mark an email as read', async () => {
      await seedEmail({ subject: 'Mark read test' });
      await waitForDelivery();

      const list = await services.imapService.listEmails(TEST_ACCOUNT_NAME, {
        subject: 'Mark read test',
      });
      const emailId = list.items[0].id;

      await services.imapService.setFlags(TEST_ACCOUNT_NAME, emailId, 'INBOX', 'read');

      const flags = await services.imapService.getEmailFlags(TEST_ACCOUNT_NAME, emailId);
      expect(flags.seen).toBe(true);
    });

    it('should mark an email as unread', async () => {
      await seedEmail({ subject: 'Mark unread test' });
      await waitForDelivery();

      const list = await services.imapService.listEmails(TEST_ACCOUNT_NAME, {
        subject: 'Mark unread test',
      });
      const emailId = list.items[0].id;

      // First mark read, then unread
      await services.imapService.setFlags(TEST_ACCOUNT_NAME, emailId, 'INBOX', 'read');
      await services.imapService.setFlags(TEST_ACCOUNT_NAME, emailId, 'INBOX', 'unread');

      const flags = await services.imapService.getEmailFlags(TEST_ACCOUNT_NAME, emailId);
      expect(flags.seen).toBe(false);
    });

    it('should flag an email', async () => {
      await seedEmail({ subject: 'Flag test' });
      await waitForDelivery();

      const list = await services.imapService.listEmails(TEST_ACCOUNT_NAME, {
        subject: 'Flag test',
      });
      const emailId = list.items[0].id;

      await services.imapService.setFlags(TEST_ACCOUNT_NAME, emailId, 'INBOX', 'flag');

      const flags = await services.imapService.getEmailFlags(TEST_ACCOUNT_NAME, emailId);
      expect(flags.flagged).toBe(true);
    });

    it('should unflag an email', async () => {
      await seedEmail({ subject: 'Unflag test' });
      await waitForDelivery();

      const list = await services.imapService.listEmails(TEST_ACCOUNT_NAME, {
        subject: 'Unflag test',
      });
      const emailId = list.items[0].id;

      await services.imapService.setFlags(TEST_ACCOUNT_NAME, emailId, 'INBOX', 'flag');
      await services.imapService.setFlags(TEST_ACCOUNT_NAME, emailId, 'INBOX', 'unflag');

      const flags = await services.imapService.getEmailFlags(TEST_ACCOUNT_NAME, emailId);
      expect(flags.flagged).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // move_email
  // ---------------------------------------------------------------------------

  describe('moveEmail', () => {
    it('should move an email to another folder', async () => {
      // Create destination folder
      await services.imapService.createMailbox(TEST_ACCOUNT_NAME, 'TestArchive');

      await seedEmail({ subject: 'Move test email' });
      await waitForDelivery();

      const list = await services.imapService.listEmails(TEST_ACCOUNT_NAME, {
        subject: 'Move test email',
      });
      const emailId = list.items[0].id;

      await services.imapService.moveEmail(TEST_ACCOUNT_NAME, emailId, 'INBOX', 'TestArchive');

      // Verify email is in destination
      const destList = await services.imapService.listEmails(TEST_ACCOUNT_NAME, {
        mailbox: 'TestArchive',
      });
      expect(destList.items.length).toBeGreaterThanOrEqual(1);

      // Cleanup
      await services.imapService.deleteMailbox(TEST_ACCOUNT_NAME, 'TestArchive');
    });
  });

  // ---------------------------------------------------------------------------
  // delete_email
  // ---------------------------------------------------------------------------

  describe('deleteEmail', () => {
    it('should delete an email (move to Trash)', async () => {
      await seedEmail({ subject: 'Delete test email' });
      await waitForDelivery();

      const list = await services.imapService.listEmails(TEST_ACCOUNT_NAME, {
        subject: 'Delete test email',
      });
      const emailId = list.items[0].id;

      await services.imapService.deleteEmail(TEST_ACCOUNT_NAME, emailId);

      // Verify email is no longer in INBOX
      const afterList = await services.imapService.listEmails(TEST_ACCOUNT_NAME, {
        subject: 'Delete test email',
      });
      const stillInInbox = afterList.items.find((e) => e.id === emailId);
      expect(stillInInbox).toBeUndefined();
    });

    it('should permanently delete an email', async () => {
      await seedEmail({ subject: 'Permanent delete test' });
      await waitForDelivery();

      const list = await services.imapService.listEmails(TEST_ACCOUNT_NAME, {
        subject: 'Permanent delete test',
      });
      const emailId = list.items[0].id;

      await services.imapService.deleteEmail(TEST_ACCOUNT_NAME, emailId, 'INBOX', true);
    });
  });

  // ---------------------------------------------------------------------------
  // find_email_folder
  // ---------------------------------------------------------------------------

  describe('findEmailFolder', () => {
    it('should find which folder an email belongs to', async () => {
      await seedEmail({ subject: 'Find folder test' });
      await waitForDelivery();

      const list = await services.imapService.listEmails(TEST_ACCOUNT_NAME, {
        subject: 'Find folder test',
      });
      const emailId = list.items[0].id;

      const result = await services.imapService.findEmailFolder(
        TEST_ACCOUNT_NAME,
        emailId,
        'INBOX',
      );

      expect(result).toBeDefined();
      expect(result.folders).toBeInstanceOf(Array);
      expect(result.folders.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ---------------------------------------------------------------------------
  // bulk operations
  // ---------------------------------------------------------------------------

  describe('bulkSetFlags', () => {
    it('should mark multiple emails as read in bulk', async () => {
      await seedEmails(3, { subject: 'Bulk read test' });
      await waitForDelivery();

      const list = await services.imapService.listEmails(TEST_ACCOUNT_NAME, {
        subject: 'Bulk read test',
      });
      const ids = list.items.map((e) => Number.parseInt(e.id, 10));

      const result = await services.imapService.bulkSetFlags(
        TEST_ACCOUNT_NAME,
        ids,
        'INBOX',
        'mark_read',
      );

      expect(result.succeeded).toBe(ids.length);
      expect(result.failed).toBe(0);
    });
  });

  describe('bulkMove', () => {
    it('should move multiple emails in bulk', async () => {
      await services.imapService.createMailbox(TEST_ACCOUNT_NAME, 'BulkDest');

      await seedEmails(2, { subject: 'Bulk move test' });
      await waitForDelivery();

      const list = await services.imapService.listEmails(TEST_ACCOUNT_NAME, {
        subject: 'Bulk move test',
      });
      const ids = list.items.map((e) => Number.parseInt(e.id, 10));

      const result = await services.imapService.bulkMove(
        TEST_ACCOUNT_NAME,
        ids,
        'INBOX',
        'BulkDest',
      );

      expect(result.succeeded).toBe(ids.length);

      // Cleanup
      await services.imapService.deleteMailbox(TEST_ACCOUNT_NAME, 'BulkDest');
    });
  });

  describe('bulkDelete', () => {
    it('should delete multiple emails in bulk', async () => {
      await seedEmails(2, { subject: 'Bulk delete test' });
      await waitForDelivery();

      const list = await services.imapService.listEmails(TEST_ACCOUNT_NAME, {
        subject: 'Bulk delete test',
      });
      const ids = list.items.map((e) => Number.parseInt(e.id, 10));

      const result = await services.imapService.bulkDelete(TEST_ACCOUNT_NAME, ids, 'INBOX', true);

      expect(result.succeeded).toBe(ids.length);
    });
  });
});
