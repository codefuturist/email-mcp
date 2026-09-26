import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import ClipboardService from './clipboard.service.js';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

vi.mock('../logging.js', () => ({
  mcpLog: vi.fn().mockResolvedValue(undefined),
}));

const spawnMock = vi.mocked(spawn);

interface FakeChild extends EventEmitter {
  stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
  stdout: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
}

function fakeChild(exitCode = 0, stdout = ''): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdin = { write: vi.fn(), end: vi.fn() };
  child.stdout = new EventEmitter();
  child.kill = vi.fn();
  queueMicrotask(() => {
    if (stdout !== '') child.stdout.emit('data', Buffer.from(stdout));
    child.emit('close', exitCode);
  });
  return child;
}

/** All spawned children, in order, with their bin/args. */
let children: { bin: string; args: string[]; child: FakeChild }[] = [];

function arm(next?: () => FakeChild): void {
  spawnMock.mockImplementation(((bin: string, args: string[]) => {
    const child = next ? next() : fakeChild();
    children.push({ bin, args, child });
    return child;
  }) as unknown as typeof spawn);
}

function spawnsOf(bin: string): { bin: string; args: string[]; child: FakeChild }[] {
  return children.filter((c) => c.bin === bin);
}

describe('ClipboardService', () => {
  let clipboard: ClipboardService;

  beforeEach(() => {
    vi.clearAllMocks();
    children = [];
    arm();
  });

  afterEach(() => {
    clipboard?.stop();
  });

  describe('darwin', () => {
    beforeEach(() => {
      clipboard = new ClipboardService({ platform: 'darwin' });
    });

    it('writes the secret to osascript via stdin, never argv', async () => {
      const result = await clipboard.copyConcealed('482913', { clearAfterSeconds: 0 });

      expect(result).toEqual({ ok: true, concealed: true });
      const [call] = spawnsOf('osascript');
      expect(call?.args[0]).toBe('-l');
      expect(call?.args.join(' ')).toContain('ConcealedType');
      expect(call?.args.some((a) => a.includes('482913'))).toBe(false);
      expect(call?.child.stdin.write).toHaveBeenCalledWith('482913');
    });

    it('falls back to pbcopy (unconcealed) when the JXA path fails', async () => {
      let first = true;
      arm(() => {
        const failFirst = first;
        first = false;
        return fakeChild(failFirst ? 1 : 0);
      });

      const result = await clipboard.copyConcealed('482913', { clearAfterSeconds: 0 });

      expect(result).toEqual({ ok: true, concealed: false });
      const pbcopy = spawnsOf('pbcopy')[0];
      expect(pbcopy?.child.stdin.write).toHaveBeenCalledWith('482913');
    });

    it('auto-clears after the delay when the clipboard still holds our value', async () => {
      vi.useFakeTimers();
      arm(() => {
        const current = children.length;
        // Call order: 0 = JXA copy, 1 = pbpaste read-back, 2 = clear write.
        return current === 1 ? fakeChild(0, '482913') : fakeChild(0);
      });

      await clipboard.copyConcealed('482913', { clearAfterSeconds: 60 });
      await vi.advanceTimersByTimeAsync(60_000 + 50);

      expect(spawnsOf('pbpaste')).toHaveLength(1);
      const clearWrite = spawnsOf('pbcopy')[0];
      expect(clearWrite?.child.stdin.write).toHaveBeenCalledWith('');
      vi.useRealTimers();
    });

    it('leaves the clipboard alone when the user copied something newer', async () => {
      vi.useFakeTimers();
      arm(() => {
        const current = children.length;
        return current === 1 ? fakeChild(0, 'user copied this') : fakeChild(0);
      });

      await clipboard.copyConcealed('482913', { clearAfterSeconds: 60 });
      await vi.advanceTimersByTimeAsync(60_000 + 50);

      expect(spawnsOf('pbpaste')).toHaveLength(1);
      expect(spawnsOf('pbcopy')).toHaveLength(0);
      vi.useRealTimers();
    });

    it('schedules no clear when clearAfterSeconds is 0', async () => {
      vi.useFakeTimers();
      await clipboard.copyConcealed('482913', { clearAfterSeconds: 0 });
      await vi.advanceTimersByTimeAsync(600_000);

      expect(children).toHaveLength(1);
      vi.useRealTimers();
    });

    it('recovers rate limiting after stop() and restart (enabled toggle cycle)', async () => {
      vi.useFakeTimers();
      clipboard.stop();

      for (let i = 0; i < 12; i += 1) {
        await clipboard.copyConcealed(`code${i}`, { clearAfterSeconds: 0 });
      }
      expect(spawnsOf('osascript')).toHaveLength(10);

      await vi.advanceTimersByTimeAsync(61_000);
      const after = await clipboard.copyConcealed('fresh', { clearAfterSeconds: 0 });

      expect(after.ok).toBe(true);
      expect(spawnsOf('osascript')).toHaveLength(11);
      vi.useRealTimers();
    });

    it('rate-limits clipboard writes', async () => {
      for (let i = 0; i < 12; i += 1) {
        await clipboard.copyConcealed(`code${i}`, { clearAfterSeconds: 0 });
      }

      const last = await clipboard.copyConcealed('overflow', { clearAfterSeconds: 0 });
      expect(last.ok).toBe(false);
      expect(spawnsOf('osascript')).toHaveLength(10);
    });
  });

  describe('linux', () => {
    it('tries wl-copy first and falls back to xclip', async () => {
      clipboard = new ClipboardService({ platform: 'linux' });
      let first = true;
      arm(() => {
        const failFirst = first;
        first = false;
        return fakeChild(failFirst ? 1 : 0);
      });

      const result = await clipboard.copyConcealed('482913', { clearAfterSeconds: 0 });

      expect(result.ok).toBe(true);
      expect(spawnsOf('wl-copy')).toHaveLength(1);
      const xclip = spawnsOf('xclip')[0];
      expect(xclip?.args).toEqual(['-selection', 'clipboard']);
      expect(xclip?.child.stdin.write).toHaveBeenCalledWith('482913');
    });
  });

  describe('win32', () => {
    it('pipes the secret into PowerShell Set-Clipboard via stdin', async () => {
      clipboard = new ClipboardService({ platform: 'win32' });

      const result = await clipboard.copyConcealed('482913', { clearAfterSeconds: 0 });

      expect(result.ok).toBe(true);
      const ps = spawnsOf('powershell')[0];
      expect(ps?.args.join(' ')).toContain('Set-Clipboard');
      expect(ps?.args.some((a) => a.includes('482913'))).toBe(false);
      expect(ps?.child.stdin.write).toHaveBeenCalledWith('482913');
    });
  });
});
