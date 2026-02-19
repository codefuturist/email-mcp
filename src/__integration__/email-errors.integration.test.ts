import ConnectionManager from '../connections/manager.js';
import ImapService from '../services/imap.service.js';
import type { AccountConfig } from '../types/index.js';
import { getGreenMailPorts } from './helpers/config.js';
import type { TestServices } from './helpers/index.js';
import { buildTestAccount, createTestServices, TEST_ACCOUNT_NAME } from './helpers/index.js';

describe('Error Handling', () => {
  let services: TestServices;

  beforeAll(async () => {
    services = createTestServices(buildTestAccount());
  });

  afterAll(async () => {
    await services.connections.closeAll();
  });

  // ---------------------------------------------------------------------------
  // Bad credentials
  // ---------------------------------------------------------------------------

  describe('bad credentials', () => {
    it('should throw on invalid account name', async () => {
      await expect(services.imapService.listEmails('nonexistent-account')).rejects.toThrow(
        /not found/i,
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Missing mailbox
  // ---------------------------------------------------------------------------

  describe('missing mailbox', () => {
    it('should throw when listing emails from non-existent mailbox', async () => {
      await expect(
        services.imapService.listEmails(TEST_ACCOUNT_NAME, {
          mailbox: 'NonExistentFolder12345',
        }),
      ).rejects.toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // Invalid email ID
  // ---------------------------------------------------------------------------

  describe('invalid email ID', () => {
    it('should throw when getting email with invalid ID', async () => {
      await expect(services.imapService.getEmail(TEST_ACCOUNT_NAME, '999999')).rejects.toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // Connection failure
  // ---------------------------------------------------------------------------

  describe('connection failure', () => {
    it('should throw when connecting to wrong port', async () => {
      const { host } = getGreenMailPorts();
      const badAccount: AccountConfig = {
        name: 'bad-connection',
        email: 'bad@localhost',
        username: 'bad',
        password: 'bad',
        imap: { host, port: 1, tls: false, starttls: false, verifySsl: false },
        smtp: { host, port: 1, tls: false, starttls: false, verifySsl: false },
      };

      const badConnections = new ConnectionManager([badAccount]);
      const badImap = new ImapService(badConnections);

      await expect(badImap.listMailboxes('bad-connection')).rejects.toThrow();

      await badConnections.closeAll();
    });
  });

  // ---------------------------------------------------------------------------
  // Operations on deleted mailbox
  // ---------------------------------------------------------------------------

  describe('mailbox operations errors', () => {
    it('should throw when deleting non-existent mailbox', async () => {
      await expect(
        services.imapService.deleteMailbox(TEST_ACCOUNT_NAME, 'NonExistent99'),
      ).rejects.toThrow();
    });

    it('should throw when renaming non-existent mailbox', async () => {
      await expect(
        services.imapService.renameMailbox(TEST_ACCOUNT_NAME, 'NoSuch99', 'NewName99'),
      ).rejects.toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // Attachment not found
  // ---------------------------------------------------------------------------

  describe('attachment errors', () => {
    it('should throw when downloading non-existent attachment', async () => {
      const list = await services.imapService.listEmails(TEST_ACCOUNT_NAME, { pageSize: 1 });

      if (list.items.length > 0) {
        await expect(
          services.imapService.downloadAttachment(
            TEST_ACCOUNT_NAME,
            list.items[0].id,
            'INBOX',
            'nonexistent-file.xyz',
          ),
        ).rejects.toThrow();
      }
    });
  });
});
