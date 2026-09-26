/**
 * DialogService — foreground user interaction for caught verification hits:
 * a native confirmation dialog ("Copy code 482913?") and a hand-off to the
 * default browser for sign-in links. Zero npm deps.
 *
 * Dialogs are macOS-only for now (AppleScript `display dialog`, same
 * mechanism as the auto-calendar confirmation); other platforms report
 * `unavailable` so callers can fall back to notification-only behavior.
 * The script is piped via stdin so dialog text (which includes the code)
 * never appears in `ps` output.
 */

import { spawn } from 'node:child_process';

export interface DialogResult {
  outcome: 'confirmed' | 'declined' | 'unavailable';
  /** The clicked button label (only when outcome is `confirmed`). */
  button?: string;
}

export interface ConfirmOptions {
  buttons: string[];
  defaultButton?: string;
  /** Dialog auto-dismiss (→ `unavailable`) after this many seconds. */
  timeoutSeconds?: number;
}

const DEFAULT_TIMEOUT_SECONDS = 45;
// Dialog timeout plus headroom for osascript startup.
const EXEC_TIMEOUT_MS = (DEFAULT_TIMEOUT_SECONDS + 15) * 1000;

/** Escape a string for embedding in an AppleScript double-quoted literal. */
function escapeAppleScript(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/[\r\n\t]/g, ' ')
    .replace(/[^\x20-\x7E\u00A0-\uFFFF]/g, '')
    .slice(0, 300);
}

interface RunResult {
  ok: boolean;
  stdout: string;
}

function run(bin: string, args: string[], stdin?: string): Promise<RunResult> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (result: RunResult): void => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'ignore'] });
    } catch {
      settle({ ok: false, stdout: '' });
      return;
    }

    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill();
      settle({ ok: false, stdout: '' });
    }, EXEC_TIMEOUT_MS);
    timer.unref();

    child.on('error', () => {
      clearTimeout(timer);
      settle({ ok: false, stdout: '' });
    });
    child.stdout?.on('data', (d: Buffer) => chunks.push(d));
    child.on('close', (code) => {
      clearTimeout(timer);
      settle({ ok: code === 0, stdout: Buffer.concat(chunks).toString('utf8') });
    });

    if (stdin !== undefined) child.stdin?.write(stdin);
    child.stdin?.end();
  });
}

export default class DialogService {
  private readonly platform: NodeJS.Platform;

  constructor(opts: { platform?: NodeJS.Platform } = {}) {
    this.platform = opts.platform ?? process.platform;
  }

  /** Whether blocking confirmation dialogs work on this platform. */
  get dialogsSupported(): boolean {
    return this.platform === 'darwin';
  }

  /**
   * Show a native confirmation dialog. A clicked non-Cancel button confirms;
   * Cancel declines; timeout, missing platform support, or any execution
   * failure yields `unavailable` (callers should degrade to notify-only —
   * never act as if the user consented).
   */
  async confirmAction(title: string, message: string, opts: ConfirmOptions): Promise<DialogResult> {
    if (!this.dialogsSupported) return { outcome: 'unavailable' };

    const buttons = opts.buttons.map((b) => `"${escapeAppleScript(b)}"`).join(', ');
    const defaultButton = escapeAppleScript(opts.defaultButton ?? opts.buttons.at(-1) ?? 'OK');
    const timeout = opts.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
    const script =
      `display dialog "${escapeAppleScript(message)}" ` +
      `with title "${escapeAppleScript(title)}" ` +
      `buttons {${buttons}} default button "${defaultButton}" ` +
      `giving up after ${timeout}`;

    // AppleScript from stdin (`osascript -`): dialog text stays out of argv.
    const result = await run('osascript', ['-'], script);
    if (!result.ok) return { outcome: 'declined' }; // Cancel exits non-zero (-128)

    if (/gave up:true/.test(result.stdout)) return { outcome: 'unavailable' };
    const button = result.stdout.match(/button returned:([^,\n]*)/)?.[1]?.trim();
    if (!button) return { outcome: 'unavailable' };
    return { outcome: 'confirmed', button };
  }

  /** Open an http(s) URL in the default browser. Never throws. */
  async openUrl(url: string): Promise<boolean> {
    if (!/^https?:\/\//i.test(url)) return false;

    if (this.platform === 'darwin') {
      return (await run('open', [url])).ok;
    }
    if (this.platform === 'linux') {
      return (await run('xdg-open', [url])).ok;
    }
    if (this.platform === 'win32') {
      // Single-quoted PS literal; quotes/backticks/$ are invalid in URLs and
      // stripped defensively so the literal cannot be escaped.
      const safe = url.replace(/['"`$]/g, '');
      return (await run('powershell', ['-NoProfile', '-Command', `Start-Process '${safe}'`])).ok;
    }
    return false;
  }
}
