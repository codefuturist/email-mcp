/**
 * Process lifecycle of the stdio transport.
 *
 * The MCP stdio contract is that the client shuts the server down by closing our
 * stdin. Until this test existed the server never noticed: StdioServerTransport
 * subscribes only to 'data' and 'error', and several services hold ref'd handles
 * (scheduler tick, hooks rate-limit timer, IMAP IDLE sockets), so the event loop
 * never drained. Any client death that skips SIGTERM — closed terminal, SIGKILL,
 * crash, MCP reconnect — left an immortal process reparented to launchd/init.
 *
 * The server runs as a real child process on purpose: the defect is the event
 * loop failing to drain, which is unobservable from inside the same process.
 */

import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const ENTRY = fileURLToPath(new URL('./main.ts', import.meta.url));

/**
 * Budget for the whole spawn → handshake → EOF → exit round trip. Everything in
 * it is local, so this is generous; its job is to fail a regression fast instead
 * of hanging CI until the framework timeout.
 */
const LIFECYCLE_BUDGET_MS = 20_000;

/** Emitted by the server once post-handshake init has started the hooks service. */
const READY_LOG = 'Email MCP server started';

let child: ChildProcessWithoutNullStreams | undefined;
let sandbox: string | undefined;

/** A test about leaked processes must not leak one itself. */
afterEach(async () => {
  if (child?.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
  }
  child = undefined;

  if (sandbox) {
    await fs.rm(sandbox, { recursive: true, force: true });
    sandbox = undefined;
  }
});

/** Resolves once the server has completed the handshake and started its services. */
async function handshakeAndWaitForReady(proc: ChildProcessWithoutNullStreams): Promise<void> {
  const initialize = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'lifecycle-test', version: '1.0.0' },
    },
  };

  return new Promise<void>((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let initialized = false;

    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();

      // Answering `initialize` means the server is live; the notification then
      // triggers the post-handshake block that pins the event loop.
      if (!initialized && stdout.includes('"id":1')) {
        initialized = true;
        proc.stdin.write(
          `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
        );
      }

      if (stdout.includes(READY_LOG)) {
        resolve();
      }
    });

    proc.once('exit', (code, signal) => {
      reject(
        new Error(
          `server exited during handshake (code=${code}, signal=${signal})\nstderr:\n${stderr}`,
        ),
      );
    });

    proc.stdin.write(`${JSON.stringify(initialize)}\n`);
  });
}

/** Resolves with the exit code, or rejects if the process outlives the budget. */
async function waitForExit(proc: ChildProcessWithoutNullStreams, ms: number): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`process still running ${ms}ms after stdin closed — orphan regression`));
    }, ms);

    proc.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code ?? -1);
    });
  });
}

describe('stdio server lifecycle', () => {
  it(
    'exits when the client closes stdin',
    async () => {
      sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'email-mcp-lifecycle-'));

      child = spawn(process.execPath, ['--import', 'tsx', ENTRY, 'stdio'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          // Confine every read and write to the sandbox, so the test cannot see
          // a developer's real config or touch a real scheduled-mail queue.
          XDG_CONFIG_HOME: path.join(sandbox, 'config'),
          XDG_DATA_HOME: path.join(sandbox, 'data'),
          XDG_STATE_HOME: path.join(sandbox, 'state'),
          // Only satisfy config validation. No tool is invoked and the watcher is
          // off, so no socket is ever opened to these hosts.
          MCP_EMAIL_ADDRESS: 'test@example.invalid',
          MCP_EMAIL_PASSWORD: 'unused',
          MCP_EMAIL_IMAP_HOST: 'imap.example.invalid',
          MCP_EMAIL_SMTP_HOST: 'smtp.example.invalid',
          MCP_EMAIL_WATCHER_ENABLED: 'false',
        },
      });

      await handshakeAndWaitForReady(child);

      child.stdin.end();

      await expect(waitForExit(child, LIFECYCLE_BUDGET_MS)).resolves.toBe(0);
    },
    LIFECYCLE_BUDGET_MS * 2,
  );
});
