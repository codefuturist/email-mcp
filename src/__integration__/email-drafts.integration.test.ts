import type { TestServices } from './helpers/index.js';
import {
  buildTestAccount,
  createTestServices,
  TEST_ACCOUNT_NAME,
  waitForDelivery,
} from './helpers/index.js';

describe('Email Draft Operations', () => {
  let services: TestServices;

  beforeAll(async () => {
    services = createTestServices(buildTestAccount());
    // GreenMail does not auto-create Drafts — create it explicitly
    try {
      await services.imapService.createMailbox(TEST_ACCOUNT_NAME, 'Drafts');
    } catch {
      // Already exists, ignore
    }
  });

  afterAll(async () => {
    await services.connections.closeAll();
  });

  // ---------------------------------------------------------------------------
  // save_draft
  // ---------------------------------------------------------------------------

  describe('saveDraft', () => {
    it('should save a draft to Drafts folder', async () => {
      const result = await services.imapService.saveDraft(TEST_ACCOUNT_NAME, {
        to: ['bob@localhost'],
        subject: 'Draft test',
        body: 'This is a draft.',
      });

      expect(result).toBeDefined();
      expect(result.id).toBeTruthy();
      expect(result.mailbox).toBeTruthy();
    });

    it('should save a draft without recipients', async () => {
      const result = await services.imapService.saveDraft(TEST_ACCOUNT_NAME, {
        to: [],
        subject: 'Empty draft',
        body: 'Draft with no recipients.',
      });

      expect(result.id).toBeTruthy();
    });
  });

  // ---------------------------------------------------------------------------
  // send_draft
  // ---------------------------------------------------------------------------

  describe('sendDraft', () => {
    it('should send a saved draft and remove it', async () => {
      // First save a draft
      const draft = await services.imapService.saveDraft(TEST_ACCOUNT_NAME, {
        to: ['bob@localhost'],
        subject: 'Draft to send',
        body: 'This draft will be sent.',
      });

      // Send the draft
      const result = await services.smtpService.sendDraft(
        TEST_ACCOUNT_NAME,
        draft.id,
        draft.mailbox,
      );

      expect(result.messageId).toBeTruthy();

      await waitForDelivery();
    });
  });
});
