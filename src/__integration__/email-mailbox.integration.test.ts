import type { TestServices } from './helpers/index.js';
import { buildTestAccount, createTestServices, TEST_ACCOUNT_NAME } from './helpers/index.js';

describe('Mailbox Management Operations', () => {
  let services: TestServices;

  beforeAll(async () => {
    services = createTestServices(buildTestAccount());
  });

  afterAll(async () => {
    await services.connections.closeAll();
  });

  // ---------------------------------------------------------------------------
  // create_mailbox
  // ---------------------------------------------------------------------------

  describe('createMailbox', () => {
    it('should create a new mailbox folder', async () => {
      await services.imapService.createMailbox(TEST_ACCOUNT_NAME, 'TestFolder');

      const mailboxes = await services.imapService.listMailboxes(TEST_ACCOUNT_NAME);
      const created = mailboxes.find((m) => m.path === 'TestFolder');
      expect(created).toBeDefined();

      // Cleanup
      await services.imapService.deleteMailbox(TEST_ACCOUNT_NAME, 'TestFolder');
    });

    it('should create a nested mailbox folder', async () => {
      await services.imapService.createMailbox(TEST_ACCOUNT_NAME, 'Parent.Child');

      const mailboxes = await services.imapService.listMailboxes(TEST_ACCOUNT_NAME);
      const created = mailboxes.find((m) => m.path === 'Parent.Child' || m.path === 'Parent/Child');
      expect(created).toBeDefined();

      // Cleanup
      try {
        await services.imapService.deleteMailbox(TEST_ACCOUNT_NAME, 'Parent.Child');
      } catch {
        await services.imapService.deleteMailbox(TEST_ACCOUNT_NAME, 'Parent/Child');
      }
    });
  });

  // ---------------------------------------------------------------------------
  // rename_mailbox
  // ---------------------------------------------------------------------------

  describe('renameMailbox', () => {
    it('should rename a mailbox folder', async () => {
      await services.imapService.createMailbox(TEST_ACCOUNT_NAME, 'OldName');

      await services.imapService.renameMailbox(TEST_ACCOUNT_NAME, 'OldName', 'NewName');

      const mailboxes = await services.imapService.listMailboxes(TEST_ACCOUNT_NAME);
      const oldExists = mailboxes.find((m) => m.path === 'OldName');
      const newExists = mailboxes.find((m) => m.path === 'NewName');

      expect(oldExists).toBeUndefined();
      expect(newExists).toBeDefined();

      // Cleanup
      await services.imapService.deleteMailbox(TEST_ACCOUNT_NAME, 'NewName');
    });
  });

  // ---------------------------------------------------------------------------
  // delete_mailbox
  // ---------------------------------------------------------------------------

  describe('deleteMailbox', () => {
    it('should delete a mailbox folder', async () => {
      await services.imapService.createMailbox(TEST_ACCOUNT_NAME, 'ToDelete');

      await services.imapService.deleteMailbox(TEST_ACCOUNT_NAME, 'ToDelete');

      const mailboxes = await services.imapService.listMailboxes(TEST_ACCOUNT_NAME);
      const deleted = mailboxes.find((m) => m.path === 'ToDelete');
      expect(deleted).toBeUndefined();
    });
  });
});
