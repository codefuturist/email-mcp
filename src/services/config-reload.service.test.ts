import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AppConfig, CredentialAlertsConfig } from '../types/index.js';
import ConfigReloadService, { applyConfigReload } from './config-reload.service.js';

vi.mock('../logging.js', () => ({
  mcpLog: vi.fn().mockResolvedValue(undefined),
}));

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('ConfigReloadService', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cfg-reload-'));
    file = join(dir, 'config.toml');
    writeFileSync(file, 'a = 1\n');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('calls the handler once per change, including a bare mtime bump', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const svc = new ConfigReloadService(file, handler, { pollMs: 20, debounceMs: 50 });
    svc.start();
    try {
      await sleep(60); // let the poller take its baseline
      writeFileSync(file, 'a = 2\n');
      await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1), { timeout: 3000 });

      // `set-secret --stdin` touches the file without changing its text when
      // the account already points at the keychain — that must count too.
      const later = new Date(Date.now() + 5000);
      utimesSync(file, later, later);
      await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(2), { timeout: 3000 });
    } finally {
      svc.stop();
    }
  });

  it('stops watching on stop()', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const svc = new ConfigReloadService(file, handler, { pollMs: 20, debounceMs: 50 });
    svc.start();
    await sleep(60);
    svc.stop();

    writeFileSync(file, 'a = 3\n');
    await sleep(300);

    expect(handler).not.toHaveBeenCalled();
  });
});

describe('applyConfigReload', () => {
  const alertsOn: CredentialAlertsConfig = {
    enabled: true,
    sound: true,
    remindEveryMinutes: 0,
    webhook: false,
  };

  function cfg(
    password: string,
    opts: { alerts?: CredentialAlertsConfig; accountOptOut?: boolean } = {},
  ): AppConfig {
    return {
      settings: { credentialAlerts: opts.alerts ?? alertsOn } as AppConfig['settings'],
      accounts: [
        {
          name: 'pandia',
          email: 'me@example.com',
          username: 'me@example.com',
          password,
          passwordRef: 'keychain:pandia',
          credentialAlerts: opts.accountOptOut === undefined ? undefined : !opts.accountOptOut,
          imap: { host: '127.0.0.1', port: 1143, tls: false, starttls: true, verifySsl: false },
          smtp: { host: '127.0.0.1', port: 1025, tls: false, starttls: true, verifySsl: false },
        },
      ],
    } as AppConfig;
  }

  function deps() {
    return {
      watcher: { retryNow: vi.fn().mockResolvedValue(undefined) },
      credentialAlerts: { updateConfig: vi.fn() },
    };
  }

  it('updates the live account object in place and retries the watcher for it', async () => {
    const live = cfg('old');
    const liveAccount = live.accounts[0];
    const d = deps();

    const summary = await applyConfigReload(live, cfg('new'), d as never);

    expect(liveAccount?.password).toBe('new'); // same object, mutated
    expect(summary.credentialsChanged).toEqual(['pandia']);
    expect(d.watcher.retryNow).toHaveBeenCalledWith('pandia');
    expect(d.credentialAlerts.updateConfig).not.toHaveBeenCalled();
  });

  it('pushes changed credential-alert settings to the service', async () => {
    const live = cfg('same');
    const quiet: CredentialAlertsConfig = {
      enabled: false,
      sound: false,
      remindEveryMinutes: 30,
      webhook: true,
    };
    const d = deps();

    const summary = await applyConfigReload(live, cfg('same', { alerts: quiet }), d as never);

    expect(d.credentialAlerts.updateConfig).toHaveBeenCalledWith(quiet);
    expect(live.settings.credentialAlerts).toEqual(quiet);
    expect(summary.alertsChanged).toBe(true);
    expect(d.watcher.retryNow).not.toHaveBeenCalled();
  });

  it('copies a changed per-account opt-out without touching the password', async () => {
    const live = cfg('same');
    const d = deps();

    const summary = await applyConfigReload(live, cfg('same', { accountOptOut: true }), d as never);

    expect(live.accounts[0]?.credentialAlerts).toBe(false);
    expect(summary.credentialsChanged).toEqual([]);
    expect(d.watcher.retryNow).not.toHaveBeenCalled();
  });

  it('reports nothing when nothing relevant changed', async () => {
    const d = deps();

    const summary = await applyConfigReload(cfg('same'), cfg('same'), d as never);

    expect(summary).toEqual({ credentialsChanged: [], alertsChanged: false });
    expect(d.watcher.retryNow).not.toHaveBeenCalled();
    expect(d.credentialAlerts.updateConfig).not.toHaveBeenCalled();
  });
});
