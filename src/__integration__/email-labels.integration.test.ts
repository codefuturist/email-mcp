import type { TestServices } from './helpers/index.js';
import {
  buildTestAccount,
  createTestServices,
  seedEmail,
  TEST_ACCOUNT_NAME,
  waitForDelivery,
} from './helpers/index.js';

describe('Email Label Operations', () => {
  let services: TestServices;

  beforeAll(async () => {
    services = createTestServices(buildTestAccount());
    await seedEmail({ subject: 'Label test email' });
    await waitForDelivery();
  });

  afterAll(async () => {
    await services.connections.closeAll();
  });

  // ---------------------------------------------------------------------------
  // list_labels
  // ---------------------------------------------------------------------------

  describe('listLabels', () => {
    it('should list available labels', async () => {
      const labels = await services.imapService.listLabels(TEST_ACCOUNT_NAME);
      expect(labels).toBeInstanceOf(Array);
    });
  });

  // ---------------------------------------------------------------------------
  // create_label + delete_label
  // ---------------------------------------------------------------------------

  describe('createLabel / deleteLabel', () => {
    it('should handle IMAP keyword lifecycle', async () => {
      // For standard IMAP, createLabel is a no-op (labels are keywords auto-created on use)
      await services.imapService.createLabel(TEST_ACCOUNT_NAME, 'TestLabel');

      // deleteLabel throws for standard IMAP keywords (cannot be deleted server-wide)
      await expect(
        services.imapService.deleteLabel(TEST_ACCOUNT_NAME, 'TestLabel'),
      ).rejects.toThrow(/cannot be deleted/i);
    });
  });

  // ---------------------------------------------------------------------------
  // add_label + remove_label
  // ---------------------------------------------------------------------------

  describe('addLabel / removeLabel', () => {
    it('should add and remove a label from an email', async () => {
      const list = await services.imapService.listEmails(TEST_ACCOUNT_NAME, {
        subject: 'Label test email',
      });
      expect(list.items.length).toBeGreaterThanOrEqual(1);
      const emailId = list.items[0].id;

      // Add label
      await services.imapService.addLabel(TEST_ACCOUNT_NAME, emailId, 'INBOX', 'MyTag');

      // Verify label is present
      const flagsAfterAdd = await services.imapService.getEmailFlags(TEST_ACCOUNT_NAME, emailId);
      expect(flagsAfterAdd.labels).toContain('MyTag');

      // Remove label
      await services.imapService.removeLabel(TEST_ACCOUNT_NAME, emailId, 'INBOX', 'MyTag');

      // Verify label is removed
      const flagsAfterRemove = await services.imapService.getEmailFlags(TEST_ACCOUNT_NAME, emailId);
      expect(flagsAfterRemove.labels).not.toContain('MyTag');
    });
  });
});
