import type { EmailMeta, HooksConfig } from '../types/index.js';
import eventBus from './event-bus.js';
import HooksService from './hooks.service.js';
import type ImapService from './imap.service.js';

// Keep OS-level side effects (desktop notifications, Calendar.app) out of the
// unit test — this suite is only about what HooksService asks IMAP to do.
vi.mock('./notifier.service.js', () => ({
  default: class {
    notify = vi.fn().mockResolvedValue(undefined);
    stop = vi.fn();
  },
}));

vi.mock('./local-calendar.service.js', () => ({
  default: class {
    addEvent = vi.fn().mockResolvedValue(undefined);
  },
}));

vi.mock('../logging.js', () => ({
  mcpLog: vi.fn().mockResolvedValue(undefined),
}));

function createMockImapService() {
  return {
    setFlags: vi.fn().mockResolvedValue(undefined),
    addLabel: vi.fn().mockResolvedValue(undefined),
  } as unknown as ImapService & {
    setFlags: ReturnType<typeof vi.fn>;
    addLabel: ReturnType<typeof vi.fn>;
  };
}

function buildConfig(overrides: Partial<HooksConfig> = {}): HooksConfig {
  return {
    onNewEmail: 'notify',
    preset: 'custom',
    autoLabel: false,
    autoFlag: false,
    batchDelay: 1,
    rules: [],
    alerts: {
      desktop: false,
      sound: false,
      urgencyThreshold: 'high',
      webhookUrl: '',
      webhookEvents: ['urgent', 'high'],
    },
    autoCalendar: false,
    calendarName: '',
    calendarAlarmMinutes: 15,
    calendarConfirm: true,
    ...overrides,
  } as HooksConfig;
}

const meta: EmailMeta = {
  id: '4242',
  subject: 'Deploy failed',
  from: { address: 'ci@example.com' },
  to: [{ address: 'me@example.com' }],
  date: new Date('2026-08-21T08:00:00Z').toISOString(),
  seen: false,
  flagged: false,
  answered: false,
  hasAttachments: false,
  labels: [],
};

describe('HooksService', () => {
  let imapService: ReturnType<typeof createMockImapService>;
  let hooks: HooksService;

  beforeEach(() => {
    vi.useFakeTimers();
    imapService = createMockImapService();
  });

  afterEach(() => {
    hooks?.stop();
    eventBus.removeAllListeners('email:new');
    vi.useRealTimers();
  });

  async function deliver(config: HooksConfig): Promise<void> {
    hooks = new HooksService(config, imapService);
    hooks.start(null);
    eventBus.emit('email:new', {
      account: 'work',
      mailbox: 'INBOX',
      emails: [meta],
    });
    await vi.advanceTimersByTimeAsync(config.batchDelay * 1000 + 50);
  }

  describe('static rule actions', () => {
    it('flags a matching email with (account, emailId, mailbox) argument order', async () => {
      await deliver(
        buildConfig({
          rules: [
            {
              name: 'flag ci',
              match: { from: 'ci@example.com' },
              actions: { flag: true },
            },
          ],
        }),
      );

      // setFlags(accountName, emailId, mailbox, action) — passing the mailbox
      // where the UID belongs makes IMAP lock a mailbox named "4242" and the
      // failure is swallowed, so the flag silently never lands.
      expect(imapService.setFlags).toHaveBeenCalledWith('work', '4242', 'INBOX', 'flag');
    });

    it('marks a matching email read with the same argument order', async () => {
      await deliver(
        buildConfig({
          rules: [
            {
              name: 'read ci',
              match: { from: 'ci@example.com' },
              actions: { markRead: true },
            },
          ],
        }),
      );

      expect(imapService.setFlags).toHaveBeenCalledWith('work', '4242', 'INBOX', 'read');
    });

    it('labels a matching email with the same argument order', async () => {
      await deliver(
        buildConfig({
          rules: [
            {
              name: 'label ci',
              match: { from: 'ci@example.com' },
              actions: { labels: ['builds'] },
            },
          ],
        }),
      );

      expect(imapService.addLabel).toHaveBeenCalledWith('work', '4242', 'INBOX', 'builds');
    });
  });
});
