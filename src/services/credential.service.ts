/**
 * Credential service — hybrid credential resolution.
 *
 * Resolves account passwords from multiple sources:
 * - "keychain"        → OS keychain (macOS Keychain, Linux libsecret)
 * - "env:VAR_NAME"    → environment variable
 * - "command:CMD"     → run CMD in a shell, use its stdout as the password
 *                       (subsumes pass, 1Password `op`, gpg, Vault, etc.)
 * - "plaintext"       → raw password from config file (deprecated, warns at runtime)
 *
 * When no credential_source is specified, falls back to the raw password field
 * in the config (treated as plaintext with a deprecation warning).
 */

import { exec as execCb, execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);
const exec = promisify(execCb);

const KEYCHAIN_SERVICE = 'email-mcp';

export type CredentialSource = string; // "keychain", "plaintext", or "env:VAR_NAME"

export interface CredentialResolution {
  password: string;
  source: 'keychain' | 'env' | 'plaintext' | 'command';
}

// ---------------------------------------------------------------------------
// Platform-specific keychain read operations
// ---------------------------------------------------------------------------

async function readKeychainMacOS(accountName: string): Promise<string> {
  try {
    const { stdout } = await execFile(
      'security',
      ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', accountName, '-w'],
      { timeout: 5000 },
    );
    return stdout.trim();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Could not read keychain entry for account "${accountName}": ${msg}\n` +
        `Store the credential with: security add-generic-password -s "${KEYCHAIN_SERVICE}" ` +
        `-a "${accountName}" -w "your-password" -U`,
    );
  }
}

async function readKeychainLinux(accountName: string): Promise<string> {
  try {
    const { stdout } = await execFile(
      'secret-tool',
      ['lookup', 'service', KEYCHAIN_SERVICE, 'account', accountName],
      { timeout: 5000 },
    );
    return stdout.trim();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Could not read secret for account "${accountName}": ${msg}\n` +
        `Store the credential with: secret-tool store --label "email-mcp: ${accountName}" ` +
        `service "${KEYCHAIN_SERVICE}" account "${accountName}"`,
    );
  }
}

async function readFromKeychain(accountName: string): Promise<string> {
  const { platform } = process;

  if (platform === 'darwin') {
    return readKeychainMacOS(accountName);
  }

  if (platform === 'linux') {
    return readKeychainLinux(accountName);
  }

  throw new Error(
    `OS keychain is not supported on platform "${platform}". ` +
      `Use credential_source = "env:VAR_NAME" or "plaintext" instead.`,
  );
}

// ---------------------------------------------------------------------------
// Command-based credential read (pass / 1Password / gpg / Vault / …)
// ---------------------------------------------------------------------------

/**
 * Run a user-configured shell command and use its stdout as the password.
 *
 * The command comes from config, which is trusted input on the same footing as
 * the code itself: anyone who can edit it can already run arbitrary code as this
 * user. We therefore intentionally run it through a shell (like msmtp's
 * `passwordeval` / mbsync's `PassCmd`) so pipes and quoting work, and we do NOT
 * sandbox it — a command that echoes or exfiltrates is a configuration mistake,
 * not a boundary this service can enforce.
 *
 * Failure modes: non-zero exit, timeout (10s), or empty stdout all throw.
 */
async function readFromCommand(command: string, accountName: string): Promise<string> {
  try {
    const { stdout } = await exec(command, { timeout: 10_000, windowsHide: true });
    const password = stdout.trim();
    if (!password) {
      throw new Error('command produced no output');
    }
    return password;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Credential command failed for account "${accountName}": ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// Platform-specific keychain write operations (for CLI setup wizard)
// ---------------------------------------------------------------------------

async function storeKeychainMacOS(accountName: string, password: string): Promise<void> {
  try {
    await execFile(
      'security',
      [
        'add-generic-password',
        '-s',
        KEYCHAIN_SERVICE,
        '-a',
        accountName,
        '-w',
        password,
        '-U', // Update if exists
      ],
      { timeout: 5000 },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to store credential in macOS Keychain: ${msg}`);
  }
}

async function storeKeychainLinux(accountName: string, password: string): Promise<void> {
  try {
    const child = execFileCb(
      'secret-tool',
      [
        'store',
        '--label',
        `email-mcp: ${accountName}`,
        'service',
        KEYCHAIN_SERVICE,
        'account',
        accountName,
      ],
      { timeout: 5000 },
      () => {},
    );
    child.stdin?.write(password);
    child.stdin?.end();
    await new Promise<void>((resolve, reject) => {
      child.on('exit', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`secret-tool exited with code ${code}`));
      });
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to store credential in libsecret: ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve a credential for a given account.
 *
 * @param accountName - The account name (used as keychain account identifier).
 * @param credentialSource - The credential source specifier.
 * @param rawPassword - The raw password from config (used for plaintext fallback).
 */
export async function resolveCredential(
  accountName: string,
  credentialSource: string | undefined,
  rawPassword: string | undefined,
): Promise<CredentialResolution> {
  const source = credentialSource ?? (rawPassword ? 'plaintext' : 'keychain');

  if (source === 'keychain') {
    const password = await readFromKeychain(accountName);
    return { password, source: 'keychain' };
  }

  if (source.startsWith('env:')) {
    const envVar = source.slice(4);
    const password = process.env[envVar];
    if (!password) {
      throw new Error(
        `Credential environment variable "${envVar}" is not set for account "${accountName}".`,
      );
    }
    return { password, source: 'env' };
  }

  if (source.startsWith('command:')) {
    const command = source.slice('command:'.length).trim();
    if (!command) {
      throw new Error(`Empty command in credential_source for account "${accountName}".`);
    }
    const password = await readFromCommand(command, accountName);
    return { password, source: 'command' };
  }

  if (source === 'plaintext') {
    if (!rawPassword) {
      throw new Error(
        `No password configured for account "${accountName}". ` +
          `Set credential_source to "keychain" or "env:VAR_NAME", or provide a password.`,
      );
    }
    return { password: rawPassword, source: 'plaintext' };
  }

  throw new Error(
    `Unknown credential_source "${source}" for account "${accountName}". ` +
      `Expected "keychain", "env:VAR_NAME", "command:CMD", or "plaintext".`,
  );
}

export async function storeInKeychain(accountName: string, password: string): Promise<void> {
  const { platform } = process;

  if (platform === 'darwin') {
    await storeKeychainMacOS(accountName, password);
  } else if (platform === 'linux') {
    await storeKeychainLinux(accountName, password);
  } else {
    throw new Error(
      `OS keychain is not supported on platform "${platform}". ` +
        `Use credential_source = "env:VAR_NAME" instead.`,
    );
  }
}

export async function deleteFromKeychain(accountName: string): Promise<void> {
  const { platform } = process;

  try {
    if (platform === 'darwin') {
      await execFile(
        'security',
        ['delete-generic-password', '-s', KEYCHAIN_SERVICE, '-a', accountName],
        { timeout: 5000 },
      );
    } else if (platform === 'linux') {
      await execFile(
        'secret-tool',
        ['clear', 'service', KEYCHAIN_SERVICE, 'account', accountName],
        { timeout: 5000 },
      );
    }
  } catch {
    // Deletion is best-effort — keychain entry may not exist
  }
}

export async function isKeychainAvailable(): Promise<boolean> {
  const { platform } = process;

  try {
    if (platform === 'darwin') {
      await execFile('security', ['list-keychains'], { timeout: 3000 });
      return true;
    }
    if (platform === 'linux') {
      await execFile('secret-tool', ['--version'], { timeout: 3000 });
      return true;
    }
  } catch {
    // Not available
  }
  return false;
}
