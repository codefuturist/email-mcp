/**
 * Server lifecycle subcommands — run the Streamable HTTP server like a
 * daemon (iMCP-style always-on), so the IMAP watcher and verification
 * catcher keep working without any MCP client holding a stdio session open.
 *
 * - server start [--attach] [http flags]  — start detached (default) or foreground
 * - server stop [--force]                 — stop the detached server
 * - server status                         — pid, address, health, uptime
 * - server restart [http flags]           — stop + start (reuses previous flags)
 * - server logs [-n N]                    — tail the daemon log
 *
 * Detached state lives in $XDG_STATE_HOME/email-mcp/daemon.json; stdout and
 * stderr go to server.log next to it. All subcommands are non-interactive
 * and script-friendly (status exits 1 when the server is not running).
 */

import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { loadConfig } from '../config/loader.js';
import { DAEMON_LOG_FILE, DAEMON_STATE_FILE } from '../config/xdg.js';
import type { ServerConfig } from '../types/index.js';

const HEALTH_TIMEOUT_MS = 1000;
const START_WAIT_MS = 10_000;
const STOP_WAIT_MS = 10_000;
const POLL_INTERVAL_MS = 500;
const LOG_ROTATE_BYTES = 5 * 1024 * 1024;
const DEFAULT_LOG_LINES = 40;

const LAUNCHD_LABEL = 'com.email-mcp.server';
const LAUNCHD_PLIST = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);

export interface ServerArgs {
  attach: boolean;
  force: boolean;
  lines: number;
  /** Effective bind address (flags > EMAIL_MCP_HTTP_* env > defaults). */
  host: string;
  port: number;
  /** Flags forwarded verbatim to the `http` entry point. */
  passthrough: string[];
}

/**
 * Server-level flags are consumed; everything else forwards to `http`.
 * host/port resolve with the same precedence the http entry uses:
 * flags → EMAIL_MCP_HTTP_* env → [settings.server] → defaults.
 */
export function parseServerArgs(
  argv: string[],
  env: Record<string, string | undefined> = process.env,
  serverConfig?: ServerConfig,
): ServerArgs {
  const args: ServerArgs = {
    attach: false,
    force: false,
    lines: DEFAULT_LOG_LINES,
    host: env.EMAIL_MCP_HTTP_HOST ?? serverConfig?.host ?? '127.0.0.1',
    port: Number(env.EMAIL_MCP_HTTP_PORT ?? serverConfig?.port ?? 8080),
    passthrough: [],
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    const value = argv[i + 1] ?? '';
    switch (arg) {
      case '--attach':
      case '--foreground':
        args.attach = true;
        break;
      case '--force':
        args.force = true;
        break;
      case '-n':
      case '--lines':
        args.lines = Number(value) || DEFAULT_LOG_LINES;
        i += 1;
        break;
      case '--host':
        args.host = value;
        args.passthrough.push(arg, value);
        i += 1;
        break;
      case '--port':
        args.port = Number(value);
        args.passthrough.push(arg, value);
        i += 1;
        break;
      case '--path':
      case '--token':
      case '--allowed-hosts':
        args.passthrough.push(arg, value);
        i += 1;
        break;
      default:
        args.passthrough.push(arg);
        break;
    }
  }

  if (!Number.isInteger(args.port) || args.port < 1 || args.port > 65535) {
    throw new Error(`Invalid --port: ${args.port}`);
  }
  return args;
}

/**
 * PID-reuse guard: only ever signal a process whose command line looks like
 * this server. An unknown or unreadable command line is treated as NOT ours.
 */
export function looksLikeOurServer(cmdline: string | undefined): boolean {
  if (!cmdline) return false;
  return /email-mcp|main\.js/.test(cmdline);
}

/** Last `n` lines of `text`, ignoring a trailing newline. */
export function tailLines(text: string, n: number): string {
  const lines = text.replace(/\n$/, '').split('\n');
  return lines.slice(Math.max(0, lines.length - n)).join('\n');
}

/**
 * launchd login item: RunAtLoad + KeepAlive make the server start at login
 * and restart on crash — the config file (not flags) is its source of truth,
 * so passthrough is normally empty.
 */
export function buildLaunchdPlist(execPath: string, entry: string, passthrough: string[]): string {
  const programArgs = [execPath, entry, 'http', ...passthrough]
    .map((a) => `    <string>${a}</string>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${programArgs}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${DAEMON_LOG_FILE}</string>
  <key>StandardErrorPath</key>
  <string>${DAEMON_LOG_FILE}</string>
</dict>
</plist>
`;
}

// ---------------------------------------------------------------------------
// Daemon state
// ---------------------------------------------------------------------------

interface DaemonRecord {
  pid: number;
  host: string;
  port: number;
  startedAt: string;
  passthrough: string[];
}

async function readDaemonRecord(): Promise<DaemonRecord | undefined> {
  try {
    const raw = JSON.parse(await fsp.readFile(DAEMON_STATE_FILE, 'utf-8')) as DaemonRecord;
    if (typeof raw.pid !== 'number' || typeof raw.port !== 'number') return undefined;
    return raw;
  } catch {
    return undefined;
  }
}

async function clearDaemonRecord(): Promise<void> {
  await fsp.rm(DAEMON_STATE_FILE, { force: true });
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function processCommand(pid: number): Promise<string | undefined> {
  if (process.platform === 'win32') return Promise.resolve(undefined);
  return new Promise((resolve) => {
    execFile('ps', ['-p', String(pid), '-o', 'command='], { timeout: 3000 }, (err, stdout) => {
      resolve(err ? undefined : stdout.trim());
    });
  });
}

/** The daemon record's process, but only when it is verifiably ours. */
async function liveDaemon(): Promise<DaemonRecord | undefined> {
  const record = await readDaemonRecord();
  if (!record) return undefined;
  if (!isProcessAlive(record.pid)) return undefined;
  if (!looksLikeOurServer(await processCommand(record.pid))) return undefined;
  return record;
}

async function launchdLoaded(): Promise<boolean> {
  if (process.platform !== 'darwin') return false;
  return new Promise((resolve) => {
    execFile('launchctl', ['list', LAUNCHD_LABEL], { timeout: 3000 }, (err) => {
      resolve(!err);
    });
  });
}

function launchctl(args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('launchctl', args, { timeout: 10_000 }, (err) => {
      resolve(!err);
    });
  });
}

function probeHost(host: string): string {
  return host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
}

async function healthOk(host: string, port: number): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  try {
    const res = await fetch(`http://${probeHost(host)}:${port}/healthz`, {
      signal: controller.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

async function startServer(args: ServerArgs): Promise<void> {
  if (args.attach) {
    const { default: runHttp } = await import('./http.js');
    await runHttp(args.passthrough);
    return;
  }

  const existing = await liveDaemon();
  if (existing) {
    console.error(
      `Server already running (pid ${existing.pid}) on http://${existing.host}:${existing.port}/mcp.\n` +
        `Use 'email-mcp server restart' or 'email-mcp server stop' first.`,
    );
    process.exitCode = 1;
    return;
  }
  if (await launchdLoaded()) {
    console.error(
      `Server is managed by launchd (${LAUNCHD_LABEL}) — it is already always-on.\n` +
        `Use 'email-mcp server uninstall' first if you want a manually managed daemon.`,
    );
    process.exitCode = 1;
    return;
  }
  await clearDaemonRecord();

  const entry = process.argv[1];
  if (!entry?.endsWith('.js')) {
    throw new Error(
      'Detached mode needs the built entry point (dist/main.js or the installed ' +
        'email-mcp binary). In a dev checkout, use `server start --attach`.',
    );
  }

  await fsp.mkdir(path.dirname(DAEMON_LOG_FILE), { recursive: true });
  try {
    const { size } = await fsp.stat(DAEMON_LOG_FILE);
    if (size > LOG_ROTATE_BYTES) await fsp.rename(DAEMON_LOG_FILE, `${DAEMON_LOG_FILE}.old`);
  } catch {
    // No log yet.
  }

  const logFd = fs.openSync(DAEMON_LOG_FILE, 'a');
  const child = spawn(process.execPath, [entry, 'http', ...args.passthrough], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
  });
  fs.closeSync(logFd);
  child.unref();
  if (child.pid === undefined) throw new Error('Failed to spawn the server process.');

  const record: DaemonRecord = {
    pid: child.pid,
    host: args.host,
    port: args.port,
    startedAt: new Date().toISOString(),
    passthrough: args.passthrough,
  };
  await fsp.writeFile(DAEMON_STATE_FILE, JSON.stringify(record, null, 2), 'utf-8');

  const deadline = Date.now() + START_WAIT_MS;
  while (Date.now() < deadline) {
    if (await healthOk(args.host, args.port)) {
      console.log(`✅ Server running (pid ${child.pid}) — http://${args.host}:${args.port}/mcp`);
      console.log(`   Watcher & verification catching stay active with no client attached.`);
      console.log(`   Logs: ${DAEMON_LOG_FILE}`);
      console.log(`   Stop with: email-mcp server stop`);
      return;
    }
    if (!isProcessAlive(child.pid)) {
      await clearDaemonRecord();
      const tail = tailLines(await fsp.readFile(DAEMON_LOG_FILE, 'utf-8').catch(() => ''), 15);
      throw new Error(`Server exited during startup. Last log lines:\n${tail}`);
    }
    await sleep(POLL_INTERVAL_MS);
  }
  console.log(
    `⚠️ Server started (pid ${child.pid}) but /healthz did not answer within ${START_WAIT_MS / 1000}s.\n` +
      `   Check the logs: ${DAEMON_LOG_FILE}`,
  );
}

async function stopServer(args: ServerArgs): Promise<void> {
  const record = await readDaemonRecord();
  if (!record) {
    if (await launchdLoaded()) {
      console.error(
        `Server is managed by launchd (${LAUNCHD_LABEL}) and restarts automatically.\n` +
          `Remove it with 'email-mcp server uninstall', or pause until next login with:\n` +
          `  launchctl unload ${LAUNCHD_PLIST}`,
      );
      process.exitCode = 1;
      return;
    }
    console.log('Server is not running (no daemon state).');
    return;
  }

  const live = await liveDaemon();
  if (!live) {
    await clearDaemonRecord();
    console.log(`Removed stale daemon state (pid ${record.pid} is gone).`);
    return;
  }

  process.kill(live.pid, 'SIGTERM');
  const deadline = Date.now() + STOP_WAIT_MS;
  while (Date.now() < deadline) {
    if (!isProcessAlive(live.pid)) {
      await clearDaemonRecord();
      console.log(`✅ Server stopped (pid ${live.pid}).`);
      return;
    }
    await sleep(POLL_INTERVAL_MS);
  }

  if (args.force) {
    process.kill(live.pid, 'SIGKILL');
    await sleep(500);
    await clearDaemonRecord();
    console.log(`✅ Server killed (pid ${live.pid}) after SIGTERM timed out.`);
    return;
  }
  console.error(
    `⚠️ Server (pid ${live.pid}) did not exit within ${STOP_WAIT_MS / 1000}s. ` +
      `Retry with 'email-mcp server stop --force'.`,
  );
  process.exitCode = 1;
}

async function serverStatus(args: ServerArgs): Promise<void> {
  const record = await readDaemonRecord();
  const live = record ? await liveDaemon() : undefined;

  if (!live) {
    if (await launchdLoaded()) {
      const healthy = await healthOk(args.host, args.port);
      console.log(`✅ Server running (launchd login item)`);
      console.log(`   Label:   ${LAUNCHD_LABEL}`);
      console.log(`   Address: http://${args.host}:${args.port}/mcp`);
      console.log(`   Health:  ${healthy ? '✅ /healthz ok' : '❌ /healthz not answering'}`);
      console.log(`   Plist:   ${LAUNCHD_PLIST}`);
      console.log(`   Logs:    ${DAEMON_LOG_FILE}`);
      if (!healthy) process.exitCode = 1;
      return;
    }
    console.log(
      record
        ? `Server not running (stale state for pid ${record.pid}). 'server start' will clean up.`
        : 'Server not running.',
    );
    process.exitCode = 1;
    return;
  }

  const healthy = await healthOk(live.host, live.port);
  const uptimeMin = Math.max(0, Math.round((Date.now() - Date.parse(live.startedAt)) / 60_000));
  console.log(`✅ Server running (detached)`);
  console.log(`   PID:     ${live.pid}`);
  console.log(`   Address: http://${live.host}:${live.port}/mcp`);
  console.log(`   Health:  ${healthy ? '✅ /healthz ok' : '❌ /healthz not answering'}`);
  console.log(`   Uptime:  ${uptimeMin} min (since ${live.startedAt})`);
  console.log(`   Logs:    ${DAEMON_LOG_FILE}`);
}

async function installServer(args: ServerArgs): Promise<void> {
  if (process.platform !== 'darwin') {
    console.error(
      'server install (login item) is macOS-only for now. Use `email-mcp server start` ' +
        'or wire `email-mcp http` into your init system (systemd unit, etc.).',
    );
    process.exitCode = 1;
    return;
  }

  const entry = process.argv[1];
  if (!entry?.endsWith('.js')) {
    throw new Error(
      'Install needs the built entry point (dist/main.js or the installed email-mcp binary).',
    );
  }

  const existing = await liveDaemon();
  if (existing) {
    console.error(
      `A manually started server is running (pid ${existing.pid}). ` +
        `Run 'email-mcp server stop' first, then install.`,
    );
    process.exitCode = 1;
    return;
  }

  await fsp.mkdir(path.dirname(LAUNCHD_PLIST), { recursive: true });
  await fsp.mkdir(path.dirname(DAEMON_LOG_FILE), { recursive: true });
  await fsp.writeFile(LAUNCHD_PLIST, buildLaunchdPlist(process.execPath, entry, args.passthrough));

  await launchctl(['unload', LAUNCHD_PLIST]); // reload cleanly if it was loaded
  const loaded = await launchctl(['load', LAUNCHD_PLIST]);
  if (!loaded) {
    console.error(`❌ launchctl load failed for ${LAUNCHD_PLIST}`);
    process.exitCode = 1;
    return;
  }

  const deadline = Date.now() + START_WAIT_MS;
  while (Date.now() < deadline) {
    if (await healthOk(args.host, args.port)) {
      console.log(`✅ Installed as a login item (${LAUNCHD_LABEL})`);
      console.log(`   Address: http://${args.host}:${args.port}/mcp`);
      console.log(`   Starts at login and restarts on crash (KeepAlive).`);
      console.log(`   Config:  [settings.server] in config.toml is the source of truth.`);
      console.log(`   Plist:   ${LAUNCHD_PLIST}`);
      console.log(`   Logs:    ${DAEMON_LOG_FILE}`);
      console.log(`   Remove:  email-mcp server uninstall`);
      return;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  console.log(
    `⚠️ Login item installed, but /healthz did not answer within ${START_WAIT_MS / 1000}s.\n` +
      `   Check the logs: ${DAEMON_LOG_FILE}`,
  );
}

async function uninstallServer(): Promise<void> {
  if (process.platform !== 'darwin') {
    console.error('server uninstall is macOS-only for now.');
    process.exitCode = 1;
    return;
  }
  const wasLoaded = await launchctl(['unload', LAUNCHD_PLIST]);
  let hadPlist = true;
  try {
    await fsp.rm(LAUNCHD_PLIST);
  } catch {
    hadPlist = false;
  }
  if (wasLoaded || hadPlist) {
    console.log(`✅ Login item removed (${LAUNCHD_LABEL}). The server is stopped.`);
  } else {
    console.log('No login item was installed.');
  }
}

async function showLogs(args: ServerArgs): Promise<void> {
  try {
    const text = await fsp.readFile(DAEMON_LOG_FILE, 'utf-8');
    console.log(tailLines(text, args.lines));
  } catch {
    console.log(`No log file yet at ${DAEMON_LOG_FILE}.`);
  }
}

function printServerUsage(): void {
  console.log(`Usage: email-mcp server <subcommand>

Run the Streamable HTTP server as an always-on background service, so the
IMAP watcher and verification catching work without an attached MCP client.

Subcommands:
  start [--attach] [http flags]  Start detached (default) or in the foreground
                                 http flags: --host, --port, --path, --token,
                                 --allowed-hosts, --insecure (see 'email-mcp http')
  stop [--force]                 Stop the detached server (SIGTERM, then SIGKILL with --force)
  status                         Show pid, address, health, and uptime (exit 1 if stopped)
  restart [http flags]           Stop and start again (reuses previous flags)
  logs [-n N]                    Show the last N daemon log lines (default ${DEFAULT_LOG_LINES})
  install [http flags]           Install as a macOS login item (launchd, KeepAlive) — true always-on
  uninstall                      Remove the login item and stop the server

Binding is configured in [settings.server] in config.toml; flags and
EMAIL_MCP_HTTP_* env vars override it per invocation.
`);
}

export default async function runServerCommand(argv: string[]): Promise<void> {
  const [subcommand, ...rest] = argv;
  // Best-effort: daemon commands still work without a config file (env mode).
  const serverConfig = await loadConfig()
    .then((c) => c.settings.server)
    .catch(() => undefined);
  const args = parseServerArgs(rest, process.env, serverConfig);

  switch (subcommand) {
    case 'start':
      await startServer(args);
      return;
    case 'stop':
      await stopServer(args);
      return;
    case 'status':
      await serverStatus(args);
      return;
    case 'install':
      await installServer(args);
      return;
    case 'uninstall':
      await uninstallServer();
      return;
    case 'restart': {
      const record = await readDaemonRecord();
      await stopServer(args);
      // No new flags → reuse how the daemon was last started.
      const startArgs =
        args.passthrough.length === 0 && record ? parseServerArgs(record.passthrough) : args;
      await startServer(startArgs);
      return;
    }
    case 'logs':
      await showLogs(args);
      return;
    default:
      printServerUsage();
  }
}
