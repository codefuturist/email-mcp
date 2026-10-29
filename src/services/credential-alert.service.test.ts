import type { AccountConfig, CredentialAlertsConfig } from '../types/index.js';
import CredentialAlertService from './credential-alert.service.js';

vi.mock('../logging.js', () => ({
  mcpLog: vi.fn().mockResolvedValue(undefined),
}));

const account: AccountConfig = {
  name: 'pandia',
  email: 'me@example.com',
  username: 'me@example.com',
  password: 'stale',
  imap: { host: '127.0.0.1', port: 1143, tls: false, starttls: true, verifySsl: false },
  smtp: { host: '127.0.0.1', port: 1025, tls: false, starttls: true, verifySsl: false },
};

const other: AccountConfig = { ...account, name: 'work', email: 'me@work.example' };

/** What imapflow raises when the server answers NO [AUTHENTICATIONFAILED]. */
const rejected = () =>
  Object.assign(new Error('Invalid credentials (Failure)'), { authenticationFailed: true });

function fakeNotifier() {
  return {
    notifyRaw: vi.fn().mockResolvedValue(undefined),
    postWebhook: vi.fn().mockResolvedValue(undefined),
  };
}

const defaults: CredentialAlertsConfig = {
  enabled: true,
  sound: true,
  remindEveryMinutes: 0,
  webhook: false,
};

function build(overrides: Partial<CredentialAlertsConfig> = {}, now?: () => number) {
  const notifier = fakeNotifier();
  const alerts = new CredentialAlertService(notifier as never, { ...defaults, ...overrides }, now);
  return { notifier, alerts };
}

describe('CredentialAlertService', () => {
  it('sends one desktop notification naming the account and the piped fix', async () => {
    const { notifier, alerts } = build();

    expect(await alerts.report(account, 'IMAP', rejected())).toBe(true);

    expect(notifier.notifyRaw).toHaveBeenCalledTimes(1);
    const [title, body] = notifier.notifyRaw.mock.calls[0] as [string, string];
    expect(title).toContain('pandia');
    expect(body).toContain('IMAP');
    expect(body).toContain('127.0.0.1:1143');
    expect(body).toContain('email-mcp account set-secret pandia --stdin');
  });

  it('notifies once per failure episode, not on every retry', async () => {
    // The watcher retries a rejected password every 15 minutes; the person
    // has to be told once, not be nagged until they fix it.
    const { notifier, alerts } = build();

    await alerts.report(account, 'IMAP', rejected());
    expect(await alerts.report(account, 'IMAP', rejected())).toBe(false);

    expect(notifier.notifyRaw).toHaveBeenCalledTimes(1);
  });

  it('re-arms after the account logs in again', async () => {
    const { notifier, alerts } = build();

    await alerts.report(account, 'IMAP', rejected());
    alerts.clear('pandia');
    expect(await alerts.report(account, 'IMAP', rejected())).toBe(true);

    expect(notifier.notifyRaw).toHaveBeenCalledTimes(2);
  });

  it('tracks accounts independently', async () => {
    const { notifier, alerts } = build();

    await alerts.report(account, 'IMAP', rejected());
    expect(await alerts.report(other, 'SMTP', rejected())).toBe(true);

    expect(notifier.notifyRaw).toHaveBeenCalledTimes(2);
    expect(String(notifier.notifyRaw.mock.calls[1]?.[0])).toContain('work');
  });

  it('ignores errors that are not credential rejections', async () => {
    const { notifier, alerts } = build();
    const down = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });

    expect(await alerts.report(account, 'IMAP', down)).toBe(false);

    expect(notifier.notifyRaw).not.toHaveBeenCalled();
  });

  it('stays armed when the desktop tool fails, so the next retry can try again', async () => {
    const { notifier, alerts } = build();
    notifier.notifyRaw.mockRejectedValueOnce(new Error('osascript: not found'));

    expect(await alerts.report(account, 'IMAP', rejected())).toBe(false);
    expect(await alerts.report(account, 'IMAP', rejected())).toBe(true);

    expect(notifier.notifyRaw).toHaveBeenCalledTimes(2);
  });

  describe('configuration', () => {
    it('is silent when disabled', async () => {
      const { notifier, alerts } = build({ enabled: false });

      expect(await alerts.report(account, 'IMAP', rejected())).toBe(false);

      expect(notifier.notifyRaw).not.toHaveBeenCalled();
    });

    it('follows the sound setting', async () => {
      const quiet = build({ sound: false });
      await quiet.alerts.report(account, 'IMAP', rejected());
      expect(quiet.notifier.notifyRaw.mock.calls[0]?.[2]).toEqual({ sound: false });

      const loud = build({ sound: true });
      await loud.alerts.report(account, 'IMAP', rejected());
      expect(loud.notifier.notifyRaw.mock.calls[0]?.[2]).toEqual({ sound: true });
    });

    it('lets an account opt out while the rest stay on', async () => {
      const { notifier, alerts } = build();

      expect(await alerts.report({ ...account, credentialAlerts: false }, 'IMAP', rejected())).toBe(
        false,
      );
      expect(await alerts.report(other, 'IMAP', rejected())).toBe(true);

      expect(notifier.notifyRaw).toHaveBeenCalledTimes(1);
    });

    it('lets an account opt in even when alerts are off globally', async () => {
      const { notifier, alerts } = build({ enabled: false });

      expect(await alerts.report({ ...account, credentialAlerts: true }, 'IMAP', rejected())).toBe(
        true,
      );

      expect(notifier.notifyRaw).toHaveBeenCalledTimes(1);
    });

    it('reminds again after remind_every_minutes while still broken', async () => {
      let clock = 1_000_000;
      const { notifier, alerts } = build({ remindEveryMinutes: 60 }, () => clock);

      expect(await alerts.report(account, 'IMAP', rejected())).toBe(true);
      clock += 59 * 60_000;
      expect(await alerts.report(account, 'IMAP', rejected())).toBe(false);
      clock += 1 * 60_000;
      expect(await alerts.report(account, 'IMAP', rejected())).toBe(true);

      expect(notifier.notifyRaw).toHaveBeenCalledTimes(2);
    });

    it('also posts a credential.rejected event to the webhook when asked', async () => {
      const { notifier, alerts } = build({ webhook: true });

      await alerts.report(account, 'IMAP', rejected());

      expect(notifier.postWebhook).toHaveBeenCalledTimes(1);
      const [event, data] = notifier.postWebhook.mock.calls[0] as [string, Record<string, unknown>];
      expect(event).toBe('credential.rejected');
      expect(data).toMatchObject({
        account: 'pandia',
        email: 'me@example.com',
        protocol: 'IMAP',
        server: '127.0.0.1:1143',
      });
      expect(String(data.fix)).toContain('email-mcp account set-secret pandia --stdin');
    });

    it('leaves the webhook alone by default', async () => {
      const { notifier, alerts } = build();

      await alerts.report(account, 'IMAP', rejected());

      expect(notifier.postWebhook).not.toHaveBeenCalled();
    });

    it('can be reconfigured at runtime', async () => {
      const { notifier, alerts } = build();

      expect(alerts.updateConfig({ enabled: false })).toEqual({ ...defaults, enabled: false });
      expect(await alerts.report(account, 'IMAP', rejected())).toBe(false);

      alerts.updateConfig({ enabled: true, sound: false });
      expect(alerts.getConfig()).toEqual({ ...defaults, sound: false });
      expect(await alerts.report(account, 'IMAP', rejected())).toBe(true);
      expect(notifier.notifyRaw.mock.calls[0]?.[2]).toEqual({ sound: false });
    });
  });
});
