import type { AccountConfig, WatcherConfig } from '../types/index.js';
import eventBus from './event-bus.js';
import WatcherService from './watcher.service.js';

// Track constructed clients so tests can drive their event handlers.
const { instances } = vi.hoisted(() => ({
  instances: [] as {
    handlers: Record<string, (data: unknown) => void>;
    fetch: ReturnType<typeof vi.fn>;
  }[],
}));

// Mock imapflow module
vi.mock('imapflow', () => {
  class MockImapFlow {
    usable = true;
    mailbox = { uidNext: 100 };
    handlers: Record<string, (data: unknown) => void> = {};
    connect = vi.fn().mockResolvedValue(undefined);
    logout = vi.fn().mockResolvedValue(undefined);
    getMailboxLock = vi.fn().mockResolvedValue({ release: vi.fn() });
    fetch = vi.fn().mockImplementation(() => (async function* empty() {})());
    on = vi.fn((event: string, cb: (data: unknown) => void) => {
      this.handlers[event] = cb;
    });

    constructor() {
      instances.push(this);
    }
  }
  return { ImapFlow: MockImapFlow };
});

// Mock logging to prevent side effects
vi.mock('../logging.js', () => ({
  mcpLog: vi.fn().mockResolvedValue(undefined),
}));

// Mock event bus
vi.mock('./event-bus.js', () => ({
  default: { emit: vi.fn() },
}));

const testAccount: AccountConfig = {
  name: 'test',
  email: 'test@example.com',
  username: 'test@example.com',
  password: 'password',
  imap: { host: 'imap.example.com', port: 993, tls: true, starttls: false, verifySsl: true },
  smtp: { host: 'smtp.example.com', port: 465, tls: true, starttls: false, verifySsl: true },
};

describe('WatcherService', () => {
  beforeEach(() => {
    instances.length = 0;
  });

  it('fetches new mail as a UID range, not a sequence range', async () => {
    const config: WatcherConfig = { enabled: true, folders: ['INBOX'], idleTimeout: 1740 };
    const watcher = new WatcherService(config, [testAccount]);
    await watcher.start();

    const client = instances.at(-1);
    if (!client) throw new Error('no ImapFlow client was constructed');

    // uidNext is 100, so lastSeenUid seeds to 99 and the range is "100:*".
    client.handlers.exists({ path: 'INBOX', count: 2, prevCount: 1 });
    await vi.waitFor(() => expect(client.fetch).toHaveBeenCalled());

    // Without { uid: true } as the third argument ImapFlow reads "100:*" as a
    // *sequence* range, which addresses entirely different messages in any
    // mailbox that has ever had a message deleted.
    expect(client.fetch).toHaveBeenCalledWith('100:*', expect.anything(), { uid: true });

    await watcher.stop();
  });

  it('treats any backslash-prefixed flag as a system flag, not a label', async () => {
    const config: WatcherConfig = { enabled: true, folders: ['INBOX'], idleTimeout: 1740 };
    const watcher = new WatcherService(config, [testAccount]);
    await watcher.start();

    const client = instances.at(-1);
    if (!client) throw new Error('no ImapFlow client was constructed');

    client.fetch.mockImplementation(() =>
      (async function* gen() {
        yield {
          uid: 101,
          // \Junk is a real flag on many servers but is absent from the
          // watcher's hardcoded SYSTEM_FLAGS allowlist, so it leaks into
          // labels — while ImapService correctly excludes it.
          flags: new Set(['\\Seen', '\\Junk', 'work']),
          envelope: {
            subject: 'Quarterly report',
            from: [{ name: 'Ada', address: 'ada@example.com' }],
            to: [],
            date: new Date('2026-08-21T08:00:00Z'),
          },
        };
      })(),
    );

    client.handlers.exists({ path: 'INBOX', count: 2, prevCount: 1 });
    await vi.waitFor(() => expect(eventBus.emit).toHaveBeenCalled());

    expect(eventBus.emit).toHaveBeenCalledWith(
      'email:new',
      expect.objectContaining({
        emails: [expect.objectContaining({ id: '101', labels: ['work'] })],
      }),
    );

    await watcher.stop();
  });

  it('republishes IMAP expunge notifications on the event bus', async () => {
    const config: WatcherConfig = { enabled: true, folders: ['INBOX'], idleTimeout: 1740 };
    const watcher = new WatcherService(config, [testAccount]);
    await watcher.start();

    const client = instances.at(-1);
    if (!client) throw new Error('no ImapFlow client was constructed');

    client.handlers.expunge({ path: 'INBOX', seq: 4, uid: 88 });

    expect(eventBus.emit).toHaveBeenCalledWith('email:expunge', {
      account: 'test',
      mailbox: 'INBOX',
      uid: 88,
      seq: 4,
    });

    await watcher.stop();
  });

  it('republishes IMAP flag changes on the event bus', async () => {
    const config: WatcherConfig = { enabled: true, folders: ['INBOX'], idleTimeout: 1740 };
    const watcher = new WatcherService(config, [testAccount]);
    await watcher.start();

    const client = instances.at(-1);
    if (!client) throw new Error('no ImapFlow client was constructed');

    client.handlers.flags({ path: 'INBOX', seq: 7, uid: 91, flags: new Set(['\\Seen']) });

    expect(eventBus.emit).toHaveBeenCalledWith('email:flags', {
      account: 'test',
      mailbox: 'INBOX',
      uid: 91,
      seq: 7,
      flags: ['\\Seen'],
    });
  });

  it('still reports a flag change when the server omits the UID', async () => {
    const config: WatcherConfig = { enabled: true, folders: ['INBOX'], idleTimeout: 1740 };
    const watcher = new WatcherService(config, [testAccount]);
    await watcher.start();

    const client = instances.at(-1);
    if (!client) throw new Error('no ImapFlow client was constructed');

    // Without a UID a consumer cannot key the change — but swallowing the
    // event would leave it believing its cached flags are still valid.
    client.handlers.flags({ path: 'INBOX', seq: 7, flags: new Set(['\\Seen']) });

    expect(eventBus.emit).toHaveBeenCalledWith('email:flags', {
      account: 'test',
      mailbox: 'INBOX',
      uid: undefined,
      seq: 7,
      flags: ['\\Seen'],
    });

    await watcher.stop();
  });

  it('does not start when disabled', async () => {
    const config: WatcherConfig = { enabled: false, folders: ['INBOX'], idleTimeout: 1740 };
    const watcher = new WatcherService(config, [testAccount]);
    await watcher.start();
    expect(watcher.getStatus()).toHaveLength(0);
  });

  it('returns status after start', async () => {
    const config: WatcherConfig = { enabled: true, folders: ['INBOX'], idleTimeout: 1740 };
    const watcher = new WatcherService(config, [testAccount]);
    await watcher.start();
    const status = watcher.getStatus();
    expect(status).toHaveLength(1);
    expect(status[0].account).toBe('test');
    expect(status[0].folder).toBe('INBOX');
    expect(status[0].connected).toBe(true);
    await watcher.stop();
  });

  it('stops all connections', async () => {
    const config: WatcherConfig = { enabled: true, folders: ['INBOX'], idleTimeout: 1740 };
    const watcher = new WatcherService(config, [testAccount]);
    await watcher.start();
    await watcher.stop();
    expect(watcher.getStatus()).toHaveLength(0);
  });

  it('starts idle for multiple folders', async () => {
    const config: WatcherConfig = { enabled: true, folders: ['INBOX', 'Sent'], idleTimeout: 1740 };
    const watcher = new WatcherService(config, [testAccount]);
    await watcher.start();
    const status = watcher.getStatus();
    expect(status).toHaveLength(2);
    await watcher.stop();
  });
});
