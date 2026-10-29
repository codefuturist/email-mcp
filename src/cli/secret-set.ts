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

/**
 * Read all of stdin as the secret, stripping exactly one trailing newline
 * (LF or CRLF) — the `docker login --password-stdin` convention — so
 * `echo pw |` and `printf pw |` store the same value, while a secret that
 * genuinely ends in a newline can still be fed by supplying two.
 */
export async function readSecretFromStdin(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf-8') : (chunk as Buffer));
  }
  let secret = Buffer.concat(chunks).toString('utf-8');
  if (secret.endsWith('\r\n')) secret = secret.slice(0, -2);
  else if (secret.endsWith('\n')) secret = secret.slice(0, -1);
  if (secret.length === 0) {
    throw new Error('Refusing to store an empty secret: nothing was read from standard input.');
  }
  return secret;
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
): Promise<{ configUpdated: boolean }> {
  const secret = await readSecretFromStdin(stdin);

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
    return { configUpdated: false };
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
  return { configUpdated };
}
