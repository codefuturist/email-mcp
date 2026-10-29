import type { AccountConfig } from '../types/index.js';
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

function fakeNotifier(sound = false) {
  return {
    notifyRaw: vi.fn().mockResolvedValue(undefined),
    getConfig: () => ({ sound }),
  };
}

describe('CredentialAlertService', () => {
  it('sends one desktop notification naming the account and the piped fix', async () => {
    const notifier = fakeNotifier();
    const alerts = new CredentialAlertService(notifier as never);

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
    const notifier = fakeNotifier();
    const alerts = new CredentialAlertService(notifier as never);

    await alerts.report(account, 'IMAP', rejected());
    expect(await alerts.report(account, 'IMAP', rejected())).toBe(false);

    expect(notifier.notifyRaw).toHaveBeenCalledTimes(1);
  });

  it('re-arms after the account logs in again', async () => {
    const notifier = fakeNotifier();
    const alerts = new CredentialAlertService(notifier as never);

    await alerts.report(account, 'IMAP', rejected());
    alerts.clear('pandia');
    expect(await alerts.report(account, 'IMAP', rejected())).toBe(true);

    expect(notifier.notifyRaw).toHaveBeenCalledTimes(2);
  });

  it('tracks accounts independently', async () => {
    const notifier = fakeNotifier();
    const alerts = new CredentialAlertService(notifier as never);

    await alerts.report(account, 'IMAP', rejected());
    expect(await alerts.report(other, 'SMTP', rejected())).toBe(true);

    expect(notifier.notifyRaw).toHaveBeenCalledTimes(2);
    expect(String(notifier.notifyRaw.mock.calls[1]?.[0])).toContain('work');
  });

  it('ignores errors that are not credential rejections', async () => {
    const notifier = fakeNotifier();
    const alerts = new CredentialAlertService(notifier as never);
    const down = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });

    expect(await alerts.report(account, 'IMAP', down)).toBe(false);

    expect(notifier.notifyRaw).not.toHaveBeenCalled();
  });

  it('plays the sound when alerts.sound is on', async () => {
    const notifier = fakeNotifier(true);
    const alerts = new CredentialAlertService(notifier as never);

    await alerts.report(account, 'IMAP', rejected());

    expect(notifier.notifyRaw.mock.calls[0]?.[2]).toEqual({ sound: true });
  });

  it('stays armed when the desktop tool fails, so the next retry can try again', async () => {
    const notifier = fakeNotifier();
    notifier.notifyRaw.mockRejectedValueOnce(new Error('osascript: not found'));
    const alerts = new CredentialAlertService(notifier as never);

    expect(await alerts.report(account, 'IMAP', rejected())).toBe(false);
    expect(await alerts.report(account, 'IMAP', rejected())).toBe(true);

    expect(notifier.notifyRaw).toHaveBeenCalledTimes(2);
  });
});
