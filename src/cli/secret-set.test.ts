import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { parseSetSecretArgs, readSecretFromStdin, setSecretFromStdin } from './secret-set.js';

describe('readSecretFromStdin', () => {
  it('strips exactly one trailing newline, as `docker login --password-stdin` does', async () => {
    expect(await readSecretFromStdin(Readable.from(['hunter2\n']))).toBe('hunter2');
  });

  it('also strips a CRLF line ending', async () => {
    expect(await readSecretFromStdin(Readable.from(['hunter2\r\n']))).toBe('hunter2');
  });

  it('keeps interior newlines and all but the last trailing one', async () => {
    expect(await readSecretFromStdin(Readable.from(['a\nb\n\n']))).toBe('a\nb\n');
  });

  it('reassembles chunked input', async () => {
    expect(await readSecretFromStdin(Readable.from(['hun', 'ter2', '\n']))).toBe('hunter2');
  });

  it('rejects an empty secret rather than storing nothing', async () => {
    await expect(readSecretFromStdin(Readable.from([]))).rejects.toThrow(/empty/i);
    await expect(readSecretFromStdin(Readable.from(['\n']))).rejects.toThrow(/empty/i);
  });
});

describe('parseSetSecretArgs', () => {
  it('recognises --stdin', () => {
    expect(parseSetSecretArgs(['--stdin'])).toEqual({ stdin: true });
  });

  it('defaults to the interactive prompt', () => {
    expect(parseSetSecretArgs([])).toEqual({ stdin: false });
  });

  it('rejects unknown flags by name', () => {
    expect(() => parseSetSecretArgs(['--sdtin'])).toThrow(/--sdtin/);
  });
});

describe('setSecretFromStdin', () => {
  const CONFIG = `[[accounts]]
name = "pandia"
password = "old-plaintext"

[[accounts]]
name = "work"
password = "w"
`;

  let dir: string;
  let configPath: string;

  /** In-memory keychain: what `store` wrote is what `readBack` returns. */
  function fakeKeychain() {
    const items = new Map<string, string>();
    return {
      store: vi.fn(async (account: string, secret: string) => {
        items.set(account, secret);
      }),
      readBack: vi.fn(async (account: string) => items.get(account) ?? ''),
    };
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'secret-set-'));
    configPath = join(dir, 'config.toml');
    writeFileSync(configPath, CONFIG);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('stores the piped secret, verifies it, and points the config at the keychain', async () => {
    const keychain = fakeKeychain();

    const result = await setSecretFromStdin(
      'pandia',
      Readable.from(['s3cr3t\n']),
      configPath,
      keychain,
    );

    expect(keychain.store).toHaveBeenCalledWith('pandia', 's3cr3t');
    expect(result).toEqual({ configUpdated: true });
    const text = readFileSync(configPath, 'utf-8');
    expect(text).toContain('password = "keychain:pandia"');
    expect(text).not.toContain('old-plaintext');
    expect(text).toContain('password = "w"'); // other account untouched
    expect(statSync(configPath).mode & 0o777).toBe(0o600);
  });

  it('stores the secret but reports the config untouched when the account has no password line', async () => {
    const keychain = fakeKeychain();

    const result = await setSecretFromStdin(
      'ghost',
      Readable.from(['s3cr3t\n']),
      configPath,
      keychain,
    );

    expect(keychain.store).toHaveBeenCalledWith('ghost', 's3cr3t');
    expect(result).toEqual({ configUpdated: false });
    expect(readFileSync(configPath, 'utf-8')).toBe(CONFIG);
  });

  it('works before any config file exists', async () => {
    const result = await setSecretFromStdin(
      'pandia',
      Readable.from(['s3cr3t\n']),
      join(dir, 'missing.toml'),
      fakeKeychain(),
    );

    expect(result).toEqual({ configUpdated: false });
  });

  it('fails loudly and leaves the config alone when the keychain read-back differs', async () => {
    const keychain = fakeKeychain();
    keychain.readBack.mockResolvedValue('something-else');

    await expect(
      setSecretFromStdin('pandia', Readable.from(['s3cr3t\n']), configPath, keychain),
    ).rejects.toThrow(/verification/i);
    expect(readFileSync(configPath, 'utf-8')).toBe(CONFIG);
  });

  it('does not touch the keychain when stdin is empty', async () => {
    const keychain = fakeKeychain();

    await expect(
      setSecretFromStdin('pandia', Readable.from([]), configPath, keychain),
    ).rejects.toThrow(/empty/i);
    expect(keychain.store).not.toHaveBeenCalled();
    expect(readFileSync(configPath, 'utf-8')).toBe(CONFIG);
  });

  it('bumps the config mtime even when the text already points at the keychain', async () => {
    // Running servers watch the file; a rotation that changes only the
    // keychain item would otherwise be invisible to them.
    writeFileSync(configPath, CONFIG.replace('"old-plaintext"', '"keychain:pandia"'));
    const past = new Date('2000-01-01T00:00:00Z');
    utimesSync(configPath, past, past);

    await setSecretFromStdin('pandia', Readable.from(['s3cr3t\n']), configPath, fakeKeychain());

    expect(statSync(configPath).mtimeMs).toBeGreaterThan(past.getTime() + 1000);
  });
});
