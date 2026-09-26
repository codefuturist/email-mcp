import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import DialogService from './dialog.service.js';

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

let children: { bin: string; args: string[]; child: FakeChild }[] = [];

function arm(next?: () => FakeChild): void {
  spawnMock.mockImplementation(((bin: string, args: string[]) => {
    const child = next ? next() : fakeChild();
    children.push({ bin, args, child });
    return child;
  }) as unknown as typeof spawn);
}

describe('DialogService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    children = [];
    arm();
  });

  describe('confirmAction (darwin)', () => {
    it('returns the clicked button and passes the script via stdin, not argv', async () => {
      arm(() => fakeChild(0, 'button returned:Copy, gave up:false'));
      const dialog = new DialogService({ platform: 'darwin' });

      const result = await dialog.confirmAction('Code 482913 from GitHub', 'Copy to clipboard?', {
        buttons: ['Cancel', 'Copy'],
        defaultButton: 'Copy',
      });

      expect(result).toEqual({ outcome: 'confirmed', button: 'Copy' });
      const call = children[0];
      expect(call?.bin).toBe('osascript');
      expect(call?.args.some((a) => a.includes('482913'))).toBe(false);
      const script = call?.child.stdin.write.mock.calls[0]?.[0] as string;
      expect(script).toContain('482913');
      expect(script).toContain('"Cancel", "Copy"');
      expect(script).toContain('giving up after');
    });

    it('treats a Cancel click (non-zero exit) as declined', async () => {
      arm(() => fakeChild(1));
      const dialog = new DialogService({ platform: 'darwin' });

      const result = await dialog.confirmAction('t', 'm', { buttons: ['Cancel', 'Copy'] });

      expect(result.outcome).toBe('declined');
    });

    it('treats a timed-out dialog as unavailable', async () => {
      arm(() => fakeChild(0, 'button returned:, gave up:true'));
      const dialog = new DialogService({ platform: 'darwin' });

      const result = await dialog.confirmAction('t', 'm', { buttons: ['Cancel', 'Copy'] });

      expect(result.outcome).toBe('unavailable');
    });

    it('escapes quotes and backslashes in dialog text', async () => {
      arm(() => fakeChild(0, 'button returned:OK, gave up:false'));
      const dialog = new DialogService({ platform: 'darwin' });

      await dialog.confirmAction('say "hi" \\ there', 'm', { buttons: ['OK'] });

      const script = children[0]?.child.stdin.write.mock.calls[0]?.[0] as string;
      expect(script).toContain('say \\"hi\\" \\\\ there');
    });
  });

  it('reports unavailable on platforms without dialog support', async () => {
    const dialog = new DialogService({ platform: 'linux' });

    const result = await dialog.confirmAction('t', 'm', { buttons: ['Cancel', 'OK'] });

    expect(result.outcome).toBe('unavailable');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  describe('openUrl', () => {
    it('opens an https URL with the platform opener', async () => {
      const dialog = new DialogService({ platform: 'darwin' });

      const ok = await dialog.openUrl('https://example.com/verify?token=abc');

      expect(ok).toBe(true);
      expect(children[0]?.bin).toBe('open');
      expect(children[0]?.args).toEqual(['https://example.com/verify?token=abc']);
    });

    it('uses xdg-open on linux', async () => {
      const dialog = new DialogService({ platform: 'linux' });

      await dialog.openUrl('https://example.com/x');

      expect(children[0]?.bin).toBe('xdg-open');
    });

    it('refuses non-http(s) URLs', async () => {
      const dialog = new DialogService({ platform: 'darwin' });

      const ok = await dialog.openUrl('javascript:alert(1)');

      expect(ok).toBe(false);
      expect(spawnMock).not.toHaveBeenCalled();
    });
  });
});
