import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

import {
  buildKeychainStdinCommand,
  buildKeychainStoreArgs,
  keychainRefFor,
  keychainSupported,
  storeSecretNonInteractive,
} from './keychain-store.js';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

const spawnMock = vi.mocked(spawn);

interface FakeChild extends EventEmitter {
  stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
}

/** A child that exits with `code` once its stdin is closed. */
function fakeChild(code = 0): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdin = {
    write: vi.fn(),
    end: vi.fn(() => {
      queueMicrotask(() => child.emit('close', code));
    }),
  };
  return child;
}

describe('keychainSupported', () => {
  // storeSecretNonInteractive has a backend for exactly these two; anywhere
  // else `account add` must not offer what it cannot do.
  it('covers the platforms with a keychain backend', () => {
    expect(keychainSupported('darwin')).toBe(true);
    expect(keychainSupported('linux')).toBe(true);
  });

  it('excludes platforms with no backend', () => {
    expect(keychainSupported('win32')).toBe(false);
    expect(keychainSupported('freebsd')).toBe(false);
  });
});

describe('keychain store helpers', () => {
  it('builds hygienic security args with -w LAST (interactive prompt, no secret in argv)', () => {
    const args = buildKeychainStoreArgs('email-mcp', 'pandia');
    // -U updates an existing item; -w must be the final token so security prompts.
    expect(args).toEqual(['add-generic-password', '-U', '-s', 'email-mcp', '-a', 'pandia', '-w']);
    expect(args[args.length - 1]).toBe('-w');
    // No secret value anywhere — only identifiers.
    expect(args).not.toContain('pw');
  });

  it('produces the config reference line for an account', () => {
    expect(keychainRefFor('pandia')).toBe('keychain:pandia');
  });
});

describe('buildKeychainStdinCommand', () => {
  // `security -i` reads one command per stdin line. Hex-encoding the secret
  // (-X) means it never appears raw and cannot break the line's tokenising,
  // whatever characters it contains.
  it('hex-encodes the secret so it never appears raw and needs no quoting', () => {
    const line = buildKeychainStdinCommand('email-mcp', 'pandia', 'p r@be"$x');
    expect(line).toBe('add-generic-password -U -s "email-mcp" -a "pandia" -X 702072406265222478\n');
    expect(line).not.toContain('p r@be');
  });

  it('refuses identifiers that would break the quoted command line', () => {
    expect(() => buildKeychainStdinCommand('email-mcp', 'bad"name', 'x')).toThrow(/account/);
    expect(() => buildKeychainStdinCommand('svc\n', 'pandia', 'x')).toThrow(/service/);
  });
});

describe('storeSecretNonInteractive on macOS', () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  it('keeps the secret out of argv: drives `security -i` over stdin, hex-encoded', async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child as never);

    await storeSecretNonInteractive('pandia', 'p r@be"$x', 'email-mcp', 'darwin');

    const call = spawnMock.mock.calls[0];
    expect(call?.[0]).toBe('security');
    expect(call?.[1]).toEqual(['-i']); // nothing but the interactive flag — no secret, no identifiers
    const written = child.stdin.write.mock.calls.map((c) => String(c[0])).join('');
    expect(written).toBe(
      'add-generic-password -U -s "email-mcp" -a "pandia" -X 702072406265222478\n',
    );
    expect(written).not.toContain('p r@be');
    expect(child.stdin.end).toHaveBeenCalled();
  });

  it('rejects when security exits non-zero', async () => {
    spawnMock.mockReturnValue(fakeChild(1) as never);

    await expect(storeSecretNonInteractive('pandia', 'x', 'email-mcp', 'darwin')).rejects.toThrow(
      /security exited with code 1/,
    );
  });
});
