import type { EmailMeta, VerificationConfig } from '../types/index.js';
import eventBus from './event-bus.js';
import type ImapService from './imap.service.js';
import VerificationCatcherService, { waitForVerification } from './verification-catcher.service.js';

vi.mock('../logging.js', () => ({
  mcpLog: vi.fn().mockResolvedValue(undefined),
}));

// In-memory dedup state — the real module writes JSON under XDG state.
const processed = vi.hoisted(() => new Set<string>());
vi.mock('../utils/verification-state.js', () => ({
  isVerificationProcessed: vi.fn(async (a: string, m: string, u: string) =>
    processed.has(`${a}|${m}|${u}`),
  ),
  markVerificationProcessed: vi.fn(async (a: string, m: string, u: string) => {
    processed.add(`${a}|${m}|${u}`);
  }),
}));

function createMockImapService() {
  return {
    getEmail: vi.fn().mockResolvedValue({
      bodyText: 'Your verification code is 482913. It expires in 10 minutes.',
      bodyHtml: undefined,
    }),
  } as unknown as ImapService & { getEmail: ReturnType<typeof vi.fn> };
}

function createMockNotifier() {
  return { notifyRaw: vi.fn().mockResolvedValue(undefined) };
}

function createMockDialog() {
  return {
    confirmAction: vi.fn().mockResolvedValue({ outcome: 'confirmed', button: 'Copy' }),
    openUrl: vi.fn().mockResolvedValue(true),
    dialogsSupported: true,
  };
}

function createMockClipboard() {
  return {
    copyConcealed: vi.fn().mockResolvedValue({ ok: true, concealed: true }),
    stop: vi.fn(),
  };
}

function buildConfig(overrides: Partial<VerificationConfig> = {}): VerificationConfig {
  return {
    enabled: true,
    autoCopy: true,
    confirmCopy: false,
    notify: true,
    copyLinks: true,
    linkAction: 'open',
    clearAfterSeconds: 60,
    maxAgeMinutes: 10,
    accounts: [],
    senderAllowlist: [],
    senderDenylist: [],
    ...overrides,
  };
}

function buildMeta(overrides: Partial<EmailMeta> = {}): EmailMeta {
  return {
    id: '4242',
    subject: 'Your GitHub verification code',
    from: { name: 'GitHub', address: 'noreply@github.com' },
    to: [{ address: 'me@example.com' }],
    date: new Date(Date.now() - 30_000).toISOString(),
    seen: false,
    flagged: false,
    answered: false,
    hasAttachments: false,
    labels: [],
    ...overrides,
  };
}

describe('VerificationCatcherService', () => {
  let imapService: ReturnType<typeof createMockImapService>;
  let notifier: ReturnType<typeof createMockNotifier>;
  let clipboard: ReturnType<typeof createMockClipboard>;
  let dialog: ReturnType<typeof createMockDialog>;
  let catcher: VerificationCatcherService;

  beforeEach(() => {
    vi.clearAllMocks();
    processed.clear();
    imapService = createMockImapService();
    notifier = createMockNotifier();
    clipboard = createMockClipboard();
    dialog = createMockDialog();
  });

  afterEach(() => {
    catcher?.stop();
    eventBus.removeAllListeners('email:new');
  });

  async function deliver(
    config: VerificationConfig,
    metas: EmailMeta[],
    opts: { account?: string; mailbox?: string } = {},
  ): Promise<void> {
    catcher = new VerificationCatcherService(
      config,
      imapService,
      notifier as never,
      clipboard as never,
      dialog as never,
    );
    catcher.start();
    eventBus.emit('email:new', {
      account: opts.account ?? 'work',
      mailbox: opts.mailbox ?? 'INBOX',
      emails: metas,
    });
    await catcher.settled();
  }

  it('copies a caught code and notifies with the service name', async () => {
    await deliver(buildConfig(), [buildMeta()]);

    expect(imapService.getEmail).toHaveBeenCalledWith('work', '4242', 'INBOX');
    expect(clipboard.copyConcealed).toHaveBeenCalledWith('482913', { clearAfterSeconds: 60 });
    expect(notifier.notifyRaw).toHaveBeenCalledWith(
      expect.stringContaining('482913'),
      expect.stringContaining('clipboard'),
    );
    expect(notifier.notifyRaw.mock.calls[0]?.[0]).toContain('GitHub');
  });

  it('skips the body fetch when subject and sender look unrelated', async () => {
    await deliver(buildConfig(), [
      buildMeta({ subject: 'Weekly newsletter digest', from: { address: 'news@corp.example' } }),
    ]);

    expect(imapService.getEmail).not.toHaveBeenCalled();
  });

  it('fetches each message at most once across repeated events', async () => {
    const meta = buildMeta();
    await deliver(buildConfig(), [meta]);
    eventBus.emit('email:new', { account: 'work', mailbox: 'INBOX', emails: [meta] });
    await catcher.settled();

    expect(imapService.getEmail).toHaveBeenCalledTimes(1);
  });

  it('ignores stale messages surfacing after reconnects', async () => {
    await deliver(buildConfig({ maxAgeMinutes: 10 }), [
      buildMeta({ date: new Date(Date.now() - 2 * 3600 * 1000).toISOString() }),
    ]);

    expect(imapService.getEmail).not.toHaveBeenCalled();
  });

  it('honors the account filter', async () => {
    await deliver(buildConfig({ accounts: ['personal'] }), [buildMeta()]);

    expect(imapService.getEmail).not.toHaveBeenCalled();
  });

  it('honors the sender denylist', async () => {
    await deliver(buildConfig({ senderDenylist: ['*@github.com'] }), [buildMeta()]);

    expect(imapService.getEmail).not.toHaveBeenCalled();
  });

  it('honors the sender allowlist', async () => {
    await deliver(buildConfig({ senderAllowlist: ['*@google.com'] }), [buildMeta()]);

    expect(imapService.getEmail).not.toHaveBeenCalled();
  });

  it('registers no listener when disabled', async () => {
    await deliver(buildConfig({ enabled: false }), [buildMeta()]);

    expect(eventBus.listenerCount('email:new')).toBe(0);
    expect(imapService.getEmail).not.toHaveBeenCalled();
  });

  it('stop() detaches only its own listener', async () => {
    const sibling = vi.fn();
    eventBus.on('email:new', sibling);
    await deliver(buildConfig(), [buildMeta()]);

    catcher.stop();
    eventBus.emit('email:new', { account: 'work', mailbox: 'INBOX', emails: [] });

    expect(sibling).toHaveBeenCalledTimes(2);
  });

  it('falls back to a magic link when no code is present', async () => {
    imapService.getEmail.mockResolvedValue({
      bodyText: undefined,
      bodyHtml:
        '<a href="https://github.com/login/verify?token=Aa1Bb2Cc3Dd4Ee5Ff6Gg7Hh8">Sign in</a>',
    });

    await deliver(buildConfig({ linkAction: 'copy' }), [
      buildMeta({ subject: 'Your sign-in link' }),
    ]);

    expect(clipboard.copyConcealed).toHaveBeenCalledWith(
      'https://github.com/login/verify?token=Aa1Bb2Cc3Dd4Ee5Ff6Gg7Hh8',
      { clearAfterSeconds: 60 },
    );
    expect(notifier.notifyRaw.mock.calls[0]?.[0]).toContain('link');
  });

  it('does not copy links when copy_links is off', async () => {
    imapService.getEmail.mockResolvedValue({
      bodyText: undefined,
      bodyHtml:
        '<a href="https://github.com/login/verify?token=Aa1Bb2Cc3Dd4Ee5Ff6Gg7Hh8">Sign in</a>',
    });

    await deliver(buildConfig({ copyLinks: false }), [buildMeta({ subject: 'Your sign-in link' })]);

    expect(clipboard.copyConcealed).not.toHaveBeenCalled();
    expect(notifier.notifyRaw).not.toHaveBeenCalled();
  });

  it('notifies without copying when auto_copy is off', async () => {
    await deliver(buildConfig({ autoCopy: false }), [buildMeta()]);

    expect(clipboard.copyConcealed).not.toHaveBeenCalled();
    expect(notifier.notifyRaw).toHaveBeenCalledWith(
      expect.stringContaining('482913'),
      expect.stringContaining('off'),
    );
  });

  it('copies silently when notify is off', async () => {
    await deliver(buildConfig({ notify: false }), [buildMeta()]);

    expect(clipboard.copyConcealed).toHaveBeenCalled();
    expect(notifier.notifyRaw).not.toHaveBeenCalled();
  });

  describe('confirm_copy', () => {
    it('asks before copying and copies on confirmation', async () => {
      await deliver(buildConfig({ confirmCopy: true }), [buildMeta()]);

      expect(dialog.confirmAction).toHaveBeenCalledWith(
        expect.stringContaining('482913'),
        expect.any(String),
        expect.objectContaining({ buttons: expect.arrayContaining(['Copy']) }),
      );
      expect(clipboard.copyConcealed).toHaveBeenCalledWith('482913', { clearAfterSeconds: 60 });
    });

    it('stays silent when the user declines', async () => {
      dialog.confirmAction.mockResolvedValue({ outcome: 'declined' });

      await deliver(buildConfig({ confirmCopy: true }), [buildMeta()]);

      expect(clipboard.copyConcealed).not.toHaveBeenCalled();
      expect(notifier.notifyRaw).not.toHaveBeenCalled();
    });

    it('degrades to a notification when no dialog is available', async () => {
      dialog.confirmAction.mockResolvedValue({ outcome: 'unavailable' });

      await deliver(buildConfig({ confirmCopy: true }), [buildMeta()]);

      expect(clipboard.copyConcealed).not.toHaveBeenCalled();
      expect(notifier.notifyRaw).toHaveBeenCalledWith(
        expect.stringContaining('482913'),
        expect.any(String),
      );
    });
  });

  describe('link_action = open', () => {
    const linkBody = {
      bodyText: undefined,
      bodyHtml:
        '<a href="https://github.com/login/verify?token=Aa1Bb2Cc3Dd4Ee5Ff6Gg7Hh8">Sign in</a>',
    };

    it('offers to open and launches the browser on Open', async () => {
      imapService.getEmail.mockResolvedValue(linkBody);
      dialog.confirmAction.mockResolvedValue({ outcome: 'confirmed', button: 'Open' });

      await deliver(buildConfig(), [buildMeta({ subject: 'Your sign-in link' })]);

      expect(dialog.openUrl).toHaveBeenCalledWith(
        'https://github.com/login/verify?token=Aa1Bb2Cc3Dd4Ee5Ff6Gg7Hh8',
      );
      expect(clipboard.copyConcealed).not.toHaveBeenCalled();
    });

    it('copies instead when the user picks Copy in the dialog', async () => {
      imapService.getEmail.mockResolvedValue(linkBody);
      dialog.confirmAction.mockResolvedValue({ outcome: 'confirmed', button: 'Copy' });

      await deliver(buildConfig(), [buildMeta({ subject: 'Your sign-in link' })]);

      expect(dialog.openUrl).not.toHaveBeenCalled();
      expect(clipboard.copyConcealed).toHaveBeenCalledWith(
        'https://github.com/login/verify?token=Aa1Bb2Cc3Dd4Ee5Ff6Gg7Hh8',
        { clearAfterSeconds: 60 },
      );
    });

    it('degrades to a notification when no dialog is available', async () => {
      imapService.getEmail.mockResolvedValue(linkBody);
      dialog.confirmAction.mockResolvedValue({ outcome: 'unavailable' });

      await deliver(buildConfig(), [buildMeta({ subject: 'Your sign-in link' })]);

      expect(dialog.openUrl).not.toHaveBeenCalled();
      expect(clipboard.copyConcealed).not.toHaveBeenCalled();
      expect(notifier.notifyRaw).toHaveBeenCalledWith(
        expect.stringContaining('link'),
        expect.any(String),
      );
    });
  });
});

describe('waitForVerification', () => {
  let imapService: ImapService & {
    getEmail: ReturnType<typeof vi.fn>;
    listEmails: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    imapService = {
      listEmails: vi.fn().mockResolvedValue({ items: [] }),
      getEmail: vi.fn().mockResolvedValue({
        bodyText: 'Your verification code is 482913.',
        bodyHtml: undefined,
      }),
    } as never;
  });

  afterEach(() => {
    eventBus.removeAllListeners('email:new');
    vi.useRealTimers();
  });

  it('returns an immediate hit without waiting', async () => {
    imapService.listEmails.mockResolvedValue({ items: [buildMeta()] });

    const hit = await waitForVerification(imapService, ['work'], 'INBOX', 900_000, 30);

    expect(hit?.value).toBe('482913');
    expect(imapService.listEmails).toHaveBeenCalledTimes(1);
  });

  it('wakes up early on an email:new event instead of waiting out the poll', async () => {
    const pending = waitForVerification(imapService, ['work'], 'INBOX', 900_000, 30);
    await vi.advanceTimersByTimeAsync(0);

    imapService.listEmails.mockResolvedValue({ items: [buildMeta()] });
    eventBus.emit('email:new', { account: 'work', mailbox: 'INBOX', emails: [buildMeta()] });
    await vi.advanceTimersByTimeAsync(0);

    const hit = await pending;
    expect(hit?.value).toBe('482913');
  });

  it('returns undefined at the deadline when nothing arrives', async () => {
    const pending = waitForVerification(imapService, ['work'], 'INBOX', 900_000, 6);
    await vi.advanceTimersByTimeAsync(6_500);

    expect(await pending).toBeUndefined();
  });

  it('leaves no listener behind after resolving', async () => {
    const baseline = eventBus.listenerCount('email:new');

    const pending = waitForVerification(imapService, ['work'], 'INBOX', 900_000, 6);
    await vi.advanceTimersByTimeAsync(6_500);
    await pending;

    expect(eventBus.listenerCount('email:new')).toBe(baseline);
  });
});
