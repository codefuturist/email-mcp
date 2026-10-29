import { execFile } from 'node:child_process';
import type { AlertsConfig } from '../types/index.js';
import NotifierService from './notifier.service.js';

vi.mock('node:child_process', () => ({
  execFile: vi.fn((...args: unknown[]) => {
    const cb = args[args.length - 1] as (err: Error | null) => void;
    cb(null);
  }),
}));

vi.mock('../logging.js', () => ({
  mcpLog: vi.fn().mockResolvedValue(undefined),
}));

const execFileMock = vi.mocked(execFile);

/** The osascript -e script string of the first execFile call. */
function firstScript(): string {
  const args = execFileMock.mock.calls[0]?.[1] as string[] | undefined;
  return args?.[1] ?? '';
}

function buildAlertsConfig(overrides: Partial<AlertsConfig> = {}): AlertsConfig {
  return {
    desktop: false,
    sound: false,
    urgencyThreshold: 'high',
    webhookUrl: '',
    webhookEvents: ['urgent', 'high'],
    ...overrides,
  };
}

describe('NotifierService.notifyRaw', () => {
  let notifier: NotifierService;
  const originalPlatform = process.platform;

  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    notifier = new NotifierService(buildAlertsConfig());
  });

  afterEach(() => {
    notifier.stop();
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  it('dispatches a desktop notification even when alerts.desktop is false', async () => {
    await notifier.notifyRaw('✅ Code 482913 from GitHub', 'Copied to clipboard');

    expect(execFileMock).toHaveBeenCalledWith(
      'osascript',
      ['-e', expect.stringContaining('482913')],
      expect.anything(),
      expect.any(Function),
    );
  });

  it('sanitizes shell metacharacters out of title and body', async () => {
    await notifier.notifyRaw('Code "48$29`13"', 'from `evil`; $(rm)');

    const script = firstScript();
    expect(script).not.toMatch(/[\\`$]/);
    expect(script).toContain('482913');
  });

  it('adds the sound clause when requested', async () => {
    await notifier.notifyRaw('title', 'body', { sound: true });

    expect(firstScript()).toContain('sound name');
  });

  it('shares the per-minute desktop rate limit', async () => {
    for (let i = 0; i < 7; i += 1) {
      await notifier.notifyRaw('title', `body ${i}`);
    }

    expect(execFileMock).toHaveBeenCalledTimes(5);
  });
});

describe('NotifierService webhook dispatch', () => {
  let notifier: NotifierService;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);
    notifier = new NotifierService(
      buildAlertsConfig({ webhookUrl: 'https://hooks.example.com/wh' }),
    );
  });

  afterEach(() => {
    notifier.stop();
    vi.unstubAllGlobals();
  });

  // A compromised or misconfigured external endpoint could 302 the request
  // to an internal address after the URL itself passed validation — refuse
  // to follow it rather than silently completing an SSRF via redirect.
  it('refuses to follow a webhook redirect', async () => {
    await notifier.alert({
      account: 'test',
      sender: { address: 'a@b.c' },
      subject: 'hi',
      priority: 'high',
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(fetchMock).toHaveBeenCalledWith(
      'https://hooks.example.com/wh',
      expect.objectContaining({ redirect: 'error' }),
    );
  });

  // Without these, a webhook consumer has no way to act on the message
  // (fetch it, check its attachments) — just a sender and a subject line.
  it('carries uid, folder and hasAttachments in the webhook body', async () => {
    await notifier.alert({
      account: 'test',
      sender: { address: 'a@b.c' },
      subject: 'hi',
      priority: 'high',
      uid: '42',
      folder: 'INBOX',
      hasAttachments: true,
    });
    await new Promise((resolve) => setImmediate(resolve));

    const [, options] = fetchMock.mock.calls[0] as [string, { body: string }];
    expect(JSON.parse(options.body)).toMatchObject({
      uid: '42',
      folder: 'INBOX',
      hasAttachments: true,
    });
  });
});

describe('NotifierService.postWebhook', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('posts an arbitrary event to the configured webhook, never following redirects', async () => {
    const notifier = new NotifierService(
      buildAlertsConfig({ webhookUrl: 'https://hooks.example.com/wh' }),
    );
    await notifier.postWebhook('credential.rejected', { account: 'pandia', protocol: 'IMAP' });
    notifier.stop();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://hooks.example.com/wh');
    expect(init.redirect).toBe('error');
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      event: 'credential.rejected',
      account: 'pandia',
      protocol: 'IMAP',
    });
    expect(typeof body.timestamp).toBe('string');
  });

  it('is a no-op without a webhook URL', async () => {
    const notifier = new NotifierService(buildAlertsConfig({ webhookUrl: '' }));
    await notifier.postWebhook('credential.rejected', { account: 'pandia' });
    notifier.stop();

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
