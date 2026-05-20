/**
 * macOS Keychain integration for secure credential storage.
 *
 * Stores and retrieves email passwords using the macOS `security` CLI,
 * keeping credentials out of plaintext config files.
 *
 * Service name: "email-mcp"
 * Account key: the email address
 */

import { execFile } from 'node:child_process';

const SERVICE = 'email-mcp';

async function run(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/security', args, { timeout: 10_000 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr.trim() || err.message));
        return;
      }
      resolve(stdout);
    });
  });
}

/**
 * Retrieve a password from macOS Keychain.
 * Returns `null` if the entry does not exist.
 */
export async function getPassword(email: string): Promise<string | null> {
  try {
    const out = await run([
      'find-generic-password',
      '-s',
      SERVICE,
      '-a',
      email,
      '-w', // output password only
    ]);
    return out.trimEnd();
  } catch {
    return null;
  }
}

/**
 * Store (or update) a password in macOS Keychain.
 */
export async function setPassword(email: string, password: string): Promise<void> {
  // Delete existing entry first (ignore errors if it doesn't exist)
  try {
    await run(['delete-generic-password', '-s', SERVICE, '-a', email]);
  } catch {
    // Entry didn't exist, that's fine
  }

  await run([
    'add-generic-password',
    '-s',
    SERVICE,
    '-a',
    email,
    '-w',
    password,
    '-U', // update if exists (belt and suspenders)
  ]);
}

/**
 * Check if we're running on macOS (Keychain is macOS-only).
 */
export function isKeychainAvailable(): boolean {
  return process.platform === 'darwin';
}
