import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The watcher persists its IDLE watermark under XDG state, and WATCHER_STATE_FILE
// resolves at module load — point it at a throwaway directory before anything
// imports it, or a test run rewrites the real watermarks and the next real
// start resumes from a UID this suite invented.
const STATE_HOME = mkdtempSync(join(tmpdir(), 'watcher-'));
process.env.XDG_STATE_HOME = STATE_HOME;

afterAll(() => {
  rmSync(STATE_HOME, { recursive: true, force: true });
});

import { mcpLog } from '../logging.js';
import type { AccountConfig, WatcherConfig } from '../types/index.js';
import eventBus from './event-bus.js';

// Track constructed clients so tests can drive their event handlers.
const { instances, connectImpl } = vi.hoisted(() => ({
  instances: [] as {
    handlers: Record<string, (data: unknown) => void>;
    fetch: ReturnType<typeof vi.fn>;
    /** Constructor options, so tests can assert the credentials used. */
    options: { auth?: { user?: string; pass?: string; accessToken?: string } };
  }[],
  /** What connect() does; a test swaps it to make the server reject. */
  connectImpl: { fn: async (): Promise<void> => undefined },
}));

// Mock imapflow module
vi.mock('imapflow', () => {
  class MockImapFlow {
    usable = true;
    mailbox = { uidNext: 100 };
    handlers: Record<string, (data: unknown) => void> = {};
    connect = vi.fn(() => connectImpl.fn());
    logout = vi.fn().mockResolvedValue(undefined);
    getMailboxLock = vi.fn().mockResolvedValue({ release: vi.fn() });
    fetch = vi.fn().mockImplementation(() => (async function* empty() {})());
    on = vi.fn((event: string, cb: (data: unknown) => void) => {
      this.handlers[event] = cb;
    });

    options: { auth?: { user?: string; pass?: string; accessToken?: string } };

    constructor(options: { auth?: { user?: string; pass?: string; accessToken?: string } }) {
      this.options = options;
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

// Imported dynamically, after XDG_STATE_HOME above: a static import is hoisted
// past the assignment, and the watcher's state-file path resolves at load.
const { default: WatcherService } = await import('./watcher.service.js');

const testAccount: AccountConfig = {
  name: 'test',
  email: 'test@example.com',
  username: 'test@example.com',
  password: 'password',
  imap: { host: 'imap.example.com', port: 993, tls: true, starttls: false, verifySsl: true },
  smtp: { host: 'smtp.example.com', port: 465, tls: true, starttls: false, verifySsl: true },
};

describe('WatcherService authentication', () => {
  const config: WatcherConfig = { enabled: true, folders: ['INBOX'], idleTimeout: 1740 };

  beforeEach(() => {
    instances.length = 0;
  });

  it('authenticates a password account with its password', async () => {
    const watcher = new WatcherService(config, [testAccount]);
    await watcher.start();

    expect(instances.at(-1)?.options.auth).toEqual({
      user: 'test@example.com',
      pass: 'password',
    });

    await watcher.stop();
  });

  it('exchanges the refresh token for an access token on an OAuth2 account', async () => {
    // The watcher builds its own connections because IDLE holds the mailbox
    // lock, and it used to pass account.password as the access token — which
    // is undefined for an OAuth account, so IDLE could never authenticate and
    // the verification catcher and hooks were silently dead.
    const oauthAccount: AccountConfig = {
      ...testAccount,
      password: undefined,
      oauth2: {
        provider: 'google',
        clientId: 'id',
        clientSecret: 'secret',
        refreshToken: 'refresh',
      },
    } as AccountConfig;
    const oauthService = {
      getAccessToken: vi.fn().mockResolvedValue('access-token-123'),
    };

    const watcher = new WatcherService(config, [oauthAccount], oauthService as never);
    await watcher.start();

    expect(oauthService.getAccessToken).toHaveBeenCalledWith(oauthAccount.oauth2);
    expect(instances.at(-1)?.options.auth).toEqual({
      user: 'test@example.com',
      accessToken: 'access-token-123',
    });

    await watcher.stop();
  });

  it('re-resolves the token on reconnect rather than reusing the first one', async () => {
    // An access token is short-lived next to a 29-minute IDLE hold, so the
    // token that opened the connection may be expired by the time it drops.
    const oauthAccount: AccountConfig = {
      ...testAccount,
      password: undefined,
      oauth2: {
        provider: 'google',
        clientId: 'id',
        clientSecret: 'secret',
        refreshToken: 'refresh',
      },
    } as AccountConfig;
    const oauthService = {
      getAccessToken: vi
        .fn()
        .mockResolvedValueOnce('first-token')
        .mockResolvedValueOnce('second-token'),
    };

    const watcher = new WatcherService(config, [oauthAccount], oauthService as never);
    await watcher.start();
    expect(instances.at(-1)?.options.auth?.accessToken).toBe('first-token');

    // Drop the connection the way the server would; the watcher reconnects.
    vi.useFakeTimers();
    instances.at(-1)?.handlers.close?.(undefined);
    await vi.advanceTimersByTimeAsync(2000);
    vi.useRealTimers();

    await vi.waitFor(() => expect(oauthService.getAccessToken).toHaveBeenCalledTimes(2));
    expect(instances.at(-1)?.options.auth?.accessToken).toBe('second-token');

    await watcher.stop();
  });
});

describe('WatcherService credential rejection', () => {
  const config: WatcherConfig = { enabled: true, folders: ['INBOX'], idleTimeout: 1740 };

  const rejectAuth = async (): Promise<void> => {
    throw Object.assign(new Error('Invalid credentials (Failure)'), {
      authenticationFailed: true,
    });
  };

  beforeEach(() => {
    instances.length = 0;
    connectImpl.fn = async () => undefined;
    vi.mocked(mcpLog).mockClear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    connectImpl.fn = async () => undefined; // later suites expect a server that accepts
    vi.useRealTimers();
  });

  it('backs off for 15 minutes instead of retrying a rejected password every minute', async () => {
    // A rejected password cannot fix itself while this process runs — the
    // config is loaded once — and retrying it on the 60s connection-failure
    // cadence is exactly what trips Proton Bridge's "too many login attempts"
    // jail: 1,480 failed logins in one day from one stale account.
    connectImpl.fn = rejectAuth;
    const watcher = new WatcherService(config, [testAccount]);
    await watcher.start();
    expect(instances).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(instances).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(instances).toHaveLength(2);

    await watcher.stop();
  });

  it('logs the credential remedy at error level, naming the non-interactive fix', async () => {
    connectImpl.fn = rejectAuth;
    const watcher = new WatcherService(config, [testAccount]);
    await watcher.start();

    const errors = vi
      .mocked(mcpLog)
      .mock.calls.filter(([level]) => level === 'error')
      .map(([, , message]) => String(message));
    expect(errors.some((m) => m.includes('email-mcp account set-secret test --stdin'))).toBe(true);

    await watcher.stop();
  });

  it('reports the rejection to the credential alerts, and clears it once a login succeeds', async () => {
    const alerts = { report: vi.fn().mockResolvedValue(true), clear: vi.fn() };
    connectImpl.fn = rejectAuth;
    const watcher = new WatcherService(config, [testAccount], undefined, alerts as never);
    await watcher.start();

    expect(alerts.report).toHaveBeenCalledTimes(1);
    expect(alerts.report.mock.calls[0]?.[0]).toMatchObject({ name: 'test' });
    expect(alerts.report.mock.calls[0]?.[1]).toBe('IMAP');
    expect(alerts.clear).not.toHaveBeenCalled();

    // The password gets fixed; the next attempt is accepted.
    connectImpl.fn = async () => undefined;
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(alerts.clear).toHaveBeenCalledWith('test');

    await watcher.stop();
  });

  it('does not report a plain connection failure as a credential problem', async () => {
    const alerts = { report: vi.fn().mockResolvedValue(true), clear: vi.fn() };
    connectImpl.fn = async () => {
      throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    };
    const watcher = new WatcherService(config, [testAccount], undefined, alerts as never);
    await watcher.start();

    expect(alerts.report).not.toHaveBeenCalled();

    await watcher.stop();
  });

  it('still retries a plain connection failure on the short backoff', async () => {
    connectImpl.fn = async () => {
      throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    };
    const watcher = new WatcherService(config, [testAccount]);
    await watcher.start();
    expect(instances).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(instances).toHaveLength(2);

    await watcher.stop();
  });
});

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
    client.handlers.exists!({ path: 'INBOX', count: 2, prevCount: 1 });
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

    client.handlers.exists!({ path: 'INBOX', count: 2, prevCount: 1 });
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

    client.handlers.expunge!({ path: 'INBOX', seq: 4, uid: 88 });

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

    client.handlers.flags!({ path: 'INBOX', seq: 7, uid: 91, flags: new Set(['\\Seen']) });

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
    client.handlers.flags!({ path: 'INBOX', seq: 7, flags: new Set(['\\Seen']) });

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
    expect(status[0]!.account).toBe('test');
    expect(status[0]!.folder).toBe('INBOX');
    expect(status[0]!.connected).toBe(true);
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
