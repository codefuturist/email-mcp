/**
 * `account set-secret <name> --stdin`: the non-interactive way in.
 *
 * Plain `set-secret` hands the terminal to `security`'s own prompt, and
 * `account edit` refuses to run without a TTY — right for a human, useless
 * for an agent, a provisioning script, or a `pbpaste |` one-liner. This reads
 * the secret from standard input instead, stores it argv-clean, verifies the
 * read-back, and points config.toml at the keychain item, so a single piped
 * command leaves the account working and no plaintext behind.
 */

import { createHash } from 'node:crypto';
import { chmod, readFile, utimes, writeFile } from 'node:fs/promises';
import type { Readable } from 'node:stream';

import { CONFIG_FILE } from '../config/loader.js';
import { resolveSecret } from '../config/secret-resolver.js';
import { keychainRefFor, storeSecretNonInteractive } from './keychain-store.js';
import { rewritePasswordToKeychainRef } from './secret-migrate.js';

export interface SetSecretOptions {
  /** Read the secret from standard input instead of prompting. */
  stdin: boolean;
}

export function parseSetSecretArgs(args: string[]): SetSecretOptions {
  const opts: SetSecretOptions = { stdin: false };
  for (const arg of args) {
    if (arg === '--stdin') opts.stdin = true;
    else throw new Error(`Unknown option "${arg}" for account set-secret.`);
  }
  return opts;
}

async function readAll(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf-8') : (chunk as Buffer));
  }
  return Buffer.concat(chunks).toString('utf-8');
}

export interface ParsedSecret {
  secret: string;
  /** The input was a pasted multi-line block and only its Password field was taken. */
  extractedFromBlock: boolean;
}

/**
 * One line = the secret, with exactly one trailing newline stripped (LF,
 * CR or CRLF) — the `docker login --password-stdin` convention, so
 * `echo pw |` and `printf pw |` store the same value.
 *
 * Several lines = a pasted block. Proton Bridge's "Mailbox details" panel
 * copies hostname, port, username, password and security as one block,
 * twice (IMAP, SMTP), and that is exactly what `pbpaste |` delivers; the
 * first time it happened, 186 characters of panel text went into the
 * keychain as the password. So: take the value after a `Password` label,
 * accept the same value repeated, refuse differing values, and refuse any
 * other multi-line input rather than store it verbatim.
 */
export function parseSecretInput(raw: string): ParsedSecret {
  let text = raw;
  if (text.endsWith('\r\n')) text = text.slice(0, -2);
  else if (text.endsWith('\n') || text.endsWith('\r')) text = text.slice(0, -1);

  // Copying the one-liner to paste it into the terminal replaces the
  // password on the clipboard; `pbpaste |` then feeds the command to itself.
  // 186 characters of shell went into a keychain that way once.
  if (/\bset-secret\b|\bpbpaste\s*\|/.test(text)) {
    throw new Error(
      'The piped text is the set-secret command line itself — the clipboard still held the ' +
        'command, not the password. Paste the command first, THEN copy the password, then press Enter ' +
        '(pbpaste reads the clipboard when the command runs).',
    );
  }

  const lines = text.split(/\r\n|\r|\n/).map((line) => line.trim());
  if (lines.length === 1) {
    if (text.trim().length === 0) {
      throw new Error('Refusing to store an empty secret: nothing was read from standard input.');
    }
    return { secret: text, extractedFromBlock: false };
  }

  const values: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const inline = /^password:?\s+(\S+)$/i.exec(line);
    if (inline?.[1]) {
      values.push(inline[1]);
      continue;
    }
    if (/^password:?$/i.test(line)) {
      const next = lines.slice(i + 1).find((candidate) => candidate.length > 0);
      if (next !== undefined) values.push(next);
    }
  }

  if (values.length === 0) {
    const nonEmpty = lines.filter((line) => line.length > 0).length;
    throw new Error(
      `Expected the secret alone on one line, but standard input had ${nonEmpty} lines. ` +
        'Pipe only the password (e.g. pbpaste | … after copying just the password).',
    );
  }
  if (new Set(values).size > 1) {
    throw new Error(
      'The pasted block has Password fields that differ (IMAP vs SMTP?) — pipe the one you mean on its own.',
    );
  }
  return { secret: values[0] as string, extractedFromBlock: true };
}

/** Read all of stdin and interpret it as a secret (see parseSecretInput). */
export async function readSecretFromStdin(stream: Readable): Promise<string> {
  return parseSecretInput(await readAll(stream)).secret;
}

/** The two keychain operations this flow needs, injectable for tests. */
export interface KeychainBackend {
  store: (account: string, secret: string) => Promise<void>;
  readBack: (account: string) => Promise<string>;
}

const realKeychain: KeychainBackend = {
  store: (account, secret) => storeSecretNonInteractive(account, secret),
  readBack: (account) => resolveSecret(keychainRefFor(account)),
};

/**
 * Store `account`'s secret from `stdin` in the OS keychain, verify the stored
 * value, then rewrite the account's `password` line in the config to a
 * `keychain:<account>` reference. The config step is best-effort: an account
 * that is not in the file yet (or has no password line) still gets its secret
 * stored, and `configUpdated: false` tells the caller to print the line.
 */
export async function setSecretFromStdin(
  account: string,
  stdin: Readable,
  configPath = CONFIG_FILE,
  keychain: KeychainBackend = realKeychain,
): Promise<{ configUpdated: boolean; extractedFromBlock: boolean }> {
  const { secret, extractedFromBlock } = parseSecretInput(await readAll(stdin));

  await keychain.store(account, secret);

  // Verify the keychain now returns exactly what we stored — compare hashes,
  // never the values themselves.
  const h = (v: string) => createHash('sha256').update(v).digest('hex');
  if (h(await keychain.readBack(account)) !== h(secret)) {
    throw new Error(
      `Keychain verification failed for "${account}": the stored value does not match ` +
        `what was read back. The config was NOT changed.`,
    );
  }

  let text: string;
  try {
    text = await readFile(configPath, 'utf-8');
  } catch {
    return { configUpdated: false, extractedFromBlock };
  }

  let configUpdated = false;
  try {
    const rewritten = rewritePasswordToKeychainRef(text, account);
    if (rewritten !== text) {
      await writeFile(configPath, rewritten, { encoding: 'utf-8', mode: 0o600 });
    }
    configUpdated = true;
  } catch {
    // The account has no password line here; the caller prints what to add.
  }

  // `mode` above only applies when the file is created; an existing file
  // keeps whatever it had, so enforce owner-only explicitly.
  await chmod(configPath, 0o600);
  // Running servers watch this file and re-resolve the secret on change.
  // Bump the mtime even when the text is already a keychain reference, or a
  // keychain-only rotation would be invisible to them until a restart.
  const now = new Date();
  await utimes(configPath, now, now);
  return { configUpdated, extractedFromBlock };
}
