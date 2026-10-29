/**
 * Live config: watch config.toml and apply what can change without a restart.
 *
 * Scope is deliberate — credentials and credential-alert settings. Those are
 * the two things a person changes while a server is running (a rotated
 * password via `set-secret --stdin`, a notification they want quiet), and
 * the two whose "restart every server" cost was highest: with several MCP
 * clients each running their own email-mcp, a restart is never just one.
 * Everything else still applies on the next start.
 *
 * Polling (fs.watchFile) rather than fs.watch: editors and the CLI replace
 * the file (new inode) more often than they rewrite it, rename events are
 * unreliable across platforms, and a 2 s poll on one small file costs
 * nothing. `set-secret --stdin` touches the file even when its text is
 * unchanged, so a keychain-only rotation is seen too.
 */

import { type Stats, unwatchFile, watchFile } from 'node:fs';

import { mcpLog } from '../logging.js';
import type { AppConfig } from '../types/index.js';
import type CredentialAlertService from './credential-alert.service.js';
import type WatcherService from './watcher.service.js';

export interface ReloadDeps {
  credentialAlerts?: Pick<CredentialAlertService, 'updateConfig'>;
  watcher?: Pick<WatcherService, 'retryNow'>;
}

export interface ReloadSummary {
  /** Accounts whose password (or its reference) changed. */
  credentialsChanged: string[];
  alertsChanged: boolean;
}

/**
 * Fold a freshly loaded config into the live one. Account objects are
 * updated IN PLACE: the watcher and the connection manager hold them, so
 * their next connect uses the new secret. Accounts added or removed in the
 * file are left for the next start — they need connections and tools wired.
 */
export async function applyConfigReload(
  live: AppConfig,
  fresh: AppConfig,
  deps: ReloadDeps,
): Promise<ReloadSummary> {
  const summary: ReloadSummary = { credentialsChanged: [], alertsChanged: false };

  const before = JSON.stringify(live.settings.credentialAlerts);
  const after = JSON.stringify(fresh.settings.credentialAlerts);
  if (before !== after) {
    live.settings.credentialAlerts = { ...fresh.settings.credentialAlerts };
    deps.credentialAlerts?.updateConfig(fresh.settings.credentialAlerts);
    summary.alertsChanged = true;
  }

  const liveByName = new Map(live.accounts.map((account) => [account.name, account]));
  for (const next of fresh.accounts) {
    const current = liveByName.get(next.name);
    if (!current) continue;
    current.credentialAlerts = next.credentialAlerts;
    if (current.password !== next.password || current.passwordRef !== next.passwordRef) {
      current.password = next.password;
      current.passwordRef = next.passwordRef;
      summary.credentialsChanged.push(next.name);
    }
  }

  for (const name of summary.credentialsChanged) {
    await deps.watcher?.retryNow(name);
  }
  return summary;
}

export interface ReloadOptions {
  /** How often the file is stat'ed. */
  pollMs?: number;
  /** Quiet period after the last change before reloading (editor write bursts). */
  debounceMs?: number;
}

export default class ConfigReloadService {
  private readonly path: string;

  private readonly onChange: () => Promise<void>;

  private readonly pollMs: number;

  private readonly debounceMs: number;

  private timer: ReturnType<typeof setTimeout> | null = null;

  private running = false;

  private pending = false;

  private readonly listener = (curr: Stats, prev: Stats): void => {
    if (curr.mtimeMs === prev.mtimeMs && curr.ctimeMs === prev.ctimeMs && curr.size === prev.size) {
      return;
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.run();
    }, this.debounceMs);
  };

  constructor(path: string, onChange: () => Promise<void>, opts: ReloadOptions = {}) {
    this.path = path;
    this.onChange = onChange;
    this.pollMs = opts.pollMs ?? 2000;
    this.debounceMs = opts.debounceMs ?? 300;
  }

  start(): void {
    // persistent: false — watching must never be what keeps the process alive.
    watchFile(this.path, { interval: this.pollMs, persistent: false }, this.listener);
  }

  stop(): void {
    unwatchFile(this.path, this.listener);
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** One reload at a time; a change during a reload queues exactly one more. */
  private run(): void {
    if (this.running) {
      this.pending = true;
      return;
    }
    this.running = true;
    this.onChange()
      .catch(async (err: unknown) => {
        const detail = err instanceof Error ? err.message : String(err);
        await mcpLog('warning', 'config', `Config reload failed: ${detail}`);
      })
      .finally(() => {
        this.running = false;
        if (this.pending) {
          this.pending = false;
          this.run();
        }
      });
  }
}
