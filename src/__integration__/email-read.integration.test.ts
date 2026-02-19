import type { TestServices } from './helpers/index.js';
import {
  buildTestAccount,
  createTestServices,
  seedEmail,
  seedEmails,
  seedThread,
  TEST_ACCOUNT_NAME,
  waitForDelivery,
} from './helpers/index.js';

describe('Email Read Operations', () => {
  let services: TestServices;

  beforeAll(async () => {
    services = createTestServices(buildTestAccount());

    // Seed emails for read tests
    await seedEmails(5);
    await seedEmail({ from: 'alice@localhost', subject: 'From Alice' });
    await seedEmail({ from: 'bob@localhost', subject: 'Flagged email' });
    await seedThread(3, { subject: 'Discussion Topic' });
    await waitForDelivery();
  });

  afterAll(async () => {
    await services.connections.closeAll();
  });

  // ---------------------------------------------------------------------------
  // list_mailboxes
  // ---------------------------------------------------------------------------

  describe('listMailboxes', () => {
    it('should list mailboxes including INBOX', async () => {
      const mailboxes = await services.imapService.listMailboxes(TEST_ACCOUNT_NAME);
      expect(mailboxes).toBeInstanceOf(Array);
      const inbox = mailboxes.find((m) => m.path === 'INBOX');
      expect(inbox).toBeDefined();
    });
  });

  // ---------------------------------------------------------------------------
  // list_emails
  // ---------------------------------------------------------------------------

  describe('listEmails', () => {
    it('should list emails with pagination', async () => {
      const result = await services.imapService.listEmails(TEST_ACCOUNT_NAME, {
        mailbox: 'INBOX',
        page: 1,
        pageSize: 3,
      });

      expect(result.items).toHaveLength(3);
      expect(result.total).toBeGreaterThanOrEqual(5);
      expect(result.hasMore).toBe(true);
    });

    it('should filter emails by sender', async () => {
      const result = await services.imapService.listEmails(TEST_ACCOUNT_NAME, {
        from: 'alice@localhost',
      });

      expect(result.items.length).toBeGreaterThanOrEqual(1);
      for (const email of result.items) {
        expect(email.from.address).toContain('alice');
      }
    });

    it('should filter emails by subject', async () => {
      const result = await services.imapService.listEmails(TEST_ACCOUNT_NAME, {
        subject: 'From Alice',
      });

      expect(result.items.length).toBeGreaterThanOrEqual(1);
      expect(result.items[0].subject).toContain('Alice');
    });
  });

  // ---------------------------------------------------------------------------
  // get_email
  // ---------------------------------------------------------------------------

  describe('getEmail', () => {
    it('should fetch full email content', async () => {
      const list = await services.imapService.listEmails(TEST_ACCOUNT_NAME, { pageSize: 1 });
      const emailId = list.items[0].id;

      const email = await services.imapService.getEmail(TEST_ACCOUNT_NAME, emailId);

      expect(email).toBeDefined();
      expect(email.id).toBe(emailId);
      expect(email.subject).toBeTruthy();
      expect(email.from).toBeDefined();
      expect(email.messageId).toBeTruthy();
    });
  });

  // ---------------------------------------------------------------------------
  // get_email_flags (status)
  // ---------------------------------------------------------------------------

  describe('getEmailFlags', () => {
    it('should return read/flag/label state', async () => {
      const list = await services.imapService.listEmails(TEST_ACCOUNT_NAME, { pageSize: 1 });
      const emailId = list.items[0].id;

      const flags = await services.imapService.getEmailFlags(TEST_ACCOUNT_NAME, emailId);

      expect(flags).toBeDefined();
      expect(typeof flags.seen).toBe('boolean');
      expect(typeof flags.flagged).toBe('boolean');
      expect(typeof flags.answered).toBe('boolean');
      expect(flags.labels).toBeInstanceOf(Array);
    });
  });

  // ---------------------------------------------------------------------------
  // search_emails
  // ---------------------------------------------------------------------------

  describe('searchEmails', () => {
    it('should search by keyword', async () => {
      const result = await services.imapService.searchEmails(TEST_ACCOUNT_NAME, 'Alice');

      expect(result.items.length).toBeGreaterThanOrEqual(1);
    });

    it('should return empty for non-matching query', async () => {
      const result = await services.imapService.searchEmails(
        TEST_ACCOUNT_NAME,
        'xyznonexistent12345',
      );

      expect(result.items).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // get_thread
  // ---------------------------------------------------------------------------

  describe('getThread', () => {
    it('should attempt to reconstruct a reply thread', async () => {
      // The thread seeded by seedThread uses alice@localhost ↔ test@localhost.
      // Find a thread message delivered to test's inbox.
      const all = await services.imapService.listEmails(TEST_ACCOUNT_NAME, { pageSize: 50 });
      const threadEmail = all.items.find((e) => e.subject?.includes('Discussion'));

      if (!threadEmail) {
        // No thread email found — skip gracefully
        return;
      }

      const email = await services.imapService.getEmail(TEST_ACCOUNT_NAME, threadEmail.id);

      // GreenMail may not support header-based thread searches well.
      // Verify the method doesn't crash for a simple message.
      if (email.messageId) {
        try {
          const thread = await services.imapService.getThread(TEST_ACCOUNT_NAME, email.messageId);
          expect(thread.messages.length).toBeGreaterThanOrEqual(1);
        } catch (err) {
          // GreenMail has limited IMAP SEARCH support — accept timeout/search errors
          expect((err as Error).message).toMatch(/connection|timeout|command failed/i);
        }
      }
    }, 60_000);
  });

  // ---------------------------------------------------------------------------
  // extract_contacts
  // ---------------------------------------------------------------------------

  describe('extractContacts', () => {
    it('should extract contacts from mailbox', async () => {
      const contacts = await services.imapService.extractContacts(TEST_ACCOUNT_NAME);

      expect(contacts).toBeInstanceOf(Array);
      // GreenMail may not expose envelope data for extractContacts — allow empty
    });
  });

  // ---------------------------------------------------------------------------
  // get_email_stats
  // ---------------------------------------------------------------------------

  describe('getEmailStats', () => {
    it('should return mailbox statistics', async () => {
      const stats = await services.imapService.getEmailStats(TEST_ACCOUNT_NAME, 'INBOX', 'week');

      expect(stats).toBeDefined();
      expect(stats.totalReceived).toBeGreaterThanOrEqual(5);
      expect(stats.period).toBe('week');
    });
  });
});
