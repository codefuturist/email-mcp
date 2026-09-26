/**
 * ClipboardService — cross-platform clipboard writes for caught codes/links.
 * Zero npm deps, mirroring NotifierService's native-tool approach.
 *
 * Secrets are ALWAYS piped via stdin — never argv (visible in `ps`), and
 * never through sanitizeForShell (it would corrupt link tokens).
 *
 * macOS primary path is a JXA script that marks the pasteboard item with
 * `org.nspasteboard.ConcealedType` — the convention password managers use so
 * clipboard-history apps (Maccy etc.) skip recording it. `pbcopy` cannot set
 * that type, so it is only the fallback. See https://nspasteboard.org/.
 */

import { spawn } from 'node:child_process';
import { mcpLog } from '../logging.js';

export interface ClipboardWriteResult {
  ok: boolean;
  concealed: boolean;
  error?: string;
}

export interface ClipboardDiagnostics {
  platform: string;
  supported: boolean;
  writeTool: { name: string; available: boolean };
  readTool: { name: string; available: boolean };
  /** Whether writes can be hidden from clipboard managers on this platform. */
  concealedSupported: boolean;
  issues: string[];
  setupInstructions: string[];
}

const EXEC_TIMEOUT_MS = 5000;
const MAX_WRITES_PER_MIN = 10;

const JXA_CONCEALED_COPY = [
  "ObjC.import('AppKit');",
  'function run() {',
  '  const data = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;',
  '  const str = $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding);',
  '  const pb = $.NSPasteboard.generalPasteboard;',
  "  pb.declareTypesOwner($([$.NSPasteboardTypeString, 'org.nspasteboard.ConcealedType']), null);",
  '  pb.setStringForType(str, $.NSPasteboardTypeString);',
  "  pb.setStringForType(str, 'org.nspasteboard.ConcealedType');",
  '}',
].join('\n');

// PowerShell: read the value from stdin so it never appears in the command
// line; an empty stdin clears instead (Set-Clipboard rejects '').
const PS_COPY_FROM_STDIN =
  "$x=[Console]::In.ReadToEnd(); if($x -eq ''){Set-Clipboard $null}else{Set-Clipboard -Value $x}";

interface RunResult {
  ok: boolean;
  stdout: string;
  error?: string;
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
    } catch (err) {
      settle({ ok: false, stdout: '', error: err instanceof Error ? err.message : String(err) });
      return;
    }

    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill();
      settle({ ok: false, stdout: '', error: 'timed out' });
    }, EXEC_TIMEOUT_MS);
    timer.unref();

    child.on('error', (err) => {
      clearTimeout(timer);
      settle({ ok: false, stdout: '', error: err.message });
    });
    child.stdout?.on('data', (d: Buffer) => chunks.push(d));
    child.on('close', (code) => {
      clearTimeout(timer);
      settle({
        ok: code === 0,
        stdout: Buffer.concat(chunks).toString('utf8'),
        error: code === 0 ? undefined : `exited with code ${code}`,
      });
    });

    if (stdin !== undefined) child.stdin?.write(stdin);
    child.stdin?.end();
  });
}

export default class ClipboardService {
  private readonly platform: NodeJS.Platform;

  private writeCount = 0;

  private rateResetTimer: ReturnType<typeof setInterval> | null;

  private clearTimer: ReturnType<typeof setTimeout> | null = null;

  private lastWritten: string | null = null;

  constructor(opts: { platform?: NodeJS.Platform } = {}) {
    this.platform = opts.platform ?? process.platform;
    this.rateResetTimer = setInterval(() => {
      this.writeCount = 0;
    }, 60_000);
    this.rateResetTimer.unref();
  }

  stop(): void {
    if (this.rateResetTimer) {
      clearInterval(this.rateResetTimer);
      this.rateResetTimer = null;
    }
    if (this.clearTimer) {
      clearTimeout(this.clearTimer);
      this.clearTimer = null;
    }
  }

  /**
   * Copy `text`, concealed from clipboard managers where the platform allows.
   * With `clearAfterSeconds > 0`, the clipboard is cleared after the delay —
   * but only if it still holds `text`, so a newer user copy is never stomped.
   */
  async copyConcealed(
    text: string,
    opts: { clearAfterSeconds?: number } = {},
  ): Promise<ClipboardWriteResult> {
    if (this.writeCount >= MAX_WRITES_PER_MIN) {
      return { ok: false, concealed: false, error: 'clipboard write rate limit exceeded' };
    }
    this.writeCount += 1;

    const result = await this.write(text);
    if (!result.ok) return result;

    this.lastWritten = text;
    if (this.clearTimer) {
      clearTimeout(this.clearTimer);
      this.clearTimer = null;
    }
    const clearAfterSeconds = opts.clearAfterSeconds ?? 0;
    if (clearAfterSeconds > 0) {
      this.clearTimer = setTimeout(() => {
        this.clearIfUnchanged().catch(() => {});
      }, clearAfterSeconds * 1000);
      this.clearTimer.unref();
    }
    return result;
  }

  /** Current clipboard text, or undefined when unreadable. */
  async read(): Promise<string | undefined> {
    let result: RunResult;
    if (this.platform === 'darwin') {
      result = await run('pbpaste', []);
    } else if (this.platform === 'linux') {
      result = await run('wl-paste', ['--no-newline']);
      if (!result.ok) result = await run('xclip', ['-selection', 'clipboard', '-o']);
    } else if (this.platform === 'win32') {
      result = await run('powershell', ['-NoProfile', '-Command', 'Get-Clipboard -Raw']);
    } else {
      return undefined;
    }
    return result.ok ? result.stdout : undefined;
  }

  /** Overwrite the clipboard with an empty string. */
  async clear(): Promise<void> {
    await this.plainWrite('');
    this.lastWritten = null;
  }

  private async clearIfUnchanged(): Promise<void> {
    const expected = this.lastWritten;
    if (expected === null) return;
    const current = await this.read();
    if (current === expected) {
      await this.clear();
      await mcpLog('debug', 'clipboard', 'Auto-cleared caught value from clipboard').catch(
        () => {},
      );
    }
  }

  private async write(text: string): Promise<ClipboardWriteResult> {
    if (this.platform === 'darwin') {
      const jxa = await run('osascript', ['-l', 'JavaScript', '-e', JXA_CONCEALED_COPY], text);
      if (jxa.ok) return { ok: true, concealed: true };
      const fallback = await run('pbcopy', [], text);
      return fallback.ok
        ? { ok: true, concealed: false }
        : { ok: false, concealed: false, error: fallback.error };
    }
    const plain = await this.plainWrite(text);
    return plain.ok
      ? { ok: true, concealed: false }
      : { ok: false, concealed: false, error: plain.error };
  }

  /** Un-concealed write with the platform's plain tool (also used to clear). */
  private async plainWrite(text: string): Promise<RunResult> {
    if (this.platform === 'darwin') {
      return run('pbcopy', [], text);
    }
    if (this.platform === 'linux') {
      const wl = await run('wl-copy', [], text);
      if (wl.ok) return wl;
      return run('xclip', ['-selection', 'clipboard'], text);
    }
    if (this.platform === 'win32') {
      return run('powershell', ['-NoProfile', '-Command', PS_COPY_FROM_STDIN], text);
    }
    return { ok: false, stdout: '', error: `unsupported platform: ${this.platform}` };
  }

  // -------------------------------------------------------------------------
  // Diagnostics — mirrors NotifierService.checkPlatformSupport
  // -------------------------------------------------------------------------

  static async checkPlatformSupport(): Promise<ClipboardDiagnostics> {
    const { platform } = process;
    const issues: string[] = [];
    const instructions: string[] = [];

    const exists = async (cmd: string): Promise<boolean> => {
      const bin = platform === 'win32' ? 'where' : 'which';
      return (await run(bin, [cmd])).ok;
    };

    if (platform === 'darwin') {
      const osascriptOk = await exists('osascript');
      const pbcopyOk = await exists('pbcopy');
      if (!osascriptOk) issues.push('osascript not found (should be built-in on macOS)');
      if (!pbcopyOk) issues.push('pbcopy not found (should be built-in on macOS)');
      instructions.push(
        'Codes are written with org.nspasteboard.ConcealedType, so well-behaved',
        'clipboard managers (Maccy, Paste, …) will not record them.',
      );
      return {
        platform: 'macOS',
        supported: osascriptOk || pbcopyOk,
        writeTool: { name: 'osascript (JXA) → pbcopy', available: osascriptOk || pbcopyOk },
        readTool: { name: 'pbpaste', available: await exists('pbpaste') },
        concealedSupported: osascriptOk,
        issues,
        setupInstructions: instructions,
      };
    }

    if (platform === 'linux') {
      const wlOk = await exists('wl-copy');
      const xclipOk = await exists('xclip');
      if (!wlOk && !xclipOk) {
        issues.push('Neither wl-copy nor xclip found');
        instructions.push(
          'Install a clipboard tool:',
          '  Wayland:  sudo apt install wl-clipboard',
          '  X11:      sudo apt install xclip',
        );
      }
      instructions.push('Note: clipboard access requires a running display server.');
      return {
        platform: 'Linux',
        supported: wlOk || xclipOk,
        writeTool: { name: wlOk ? 'wl-copy' : 'xclip', available: wlOk || xclipOk },
        readTool: { name: wlOk ? 'wl-paste' : 'xclip -o', available: wlOk || xclipOk },
        concealedSupported: false,
        issues,
        setupInstructions: instructions,
      };
    }

    if (platform === 'win32') {
      const psOk = await exists('powershell');
      if (!psOk) issues.push('PowerShell not found');
      return {
        platform: 'Windows',
        supported: psOk,
        writeTool: { name: 'powershell Set-Clipboard', available: psOk },
        readTool: { name: 'powershell Get-Clipboard', available: psOk },
        concealedSupported: false,
        issues,
        setupInstructions: instructions,
      };
    }

    return {
      platform,
      supported: false,
      writeTool: { name: 'unknown', available: false },
      readTool: { name: 'unknown', available: false },
      concealedSupported: false,
      issues: [`Unsupported platform: ${platform}`],
      setupInstructions: ['Clipboard integration supports macOS, Linux, and Windows.'],
    };
  }
}
