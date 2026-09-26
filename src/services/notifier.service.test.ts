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
