/**
 * OS keychain store helpers for `email-mcp account set-secret` and friends.
 *
 * Storing a secret must never put it in argv (visible via `ps`). The macOS
 * `security` CLI offers two hygienic paths:
 *
 *   • interactive: pass `-w` as the FINAL argument with no value, so it
 *     prompts on the controlling terminal (and confirms). The secret is typed
 *     by the human into security's own prompt and never passes through this
 *     process at all. That is `set-secret` without flags.
 *   • `security -i`: interactive *command* mode, which reads one command per
 *     line from standard input. The whole `add-generic-password` line goes
 *     over that pipe with the secret hex-encoded (`-X`), so neither the secret
 *     nor the identifiers ever appear in argv. That is every non-interactive
 *     path (`set-secret --stdin`, `migrate-secret`, the `account add` wizard).
 *
 * Multi-account: each account is a distinct generic-password item sharing the
 * service "email-mcp", keyed by its account attribute. `-U` updates in place
 * when re-running for an existing account.
 */

import { spawn } from 'node:child_process';

export const KEYCHAIN_SERVICE = 'email-mcp';

/** Args for `security` to store/update account's secret via its own prompt. */
export function buildKeychainStoreArgs(service: string, account: string): string[] {
  return ['add-generic-password', '-U', '-s', service, '-a', account, '-w'];
}

/**
 * The one-line command fed to `security -i` on stdin. The secret is passed as
 * hex (`-X`), so it never appears raw and cannot break the line's tokenising
 * whatever characters it contains; the identifiers are double-quoted, which
 * `security -i` honours, so names with spaces work. A quote or newline in an
 * identifier would end the token or the command early — refuse those rather
 * than store under a truncated name.
 */
export function buildKeychainStdinCommand(
  service: string,
  account: string,
  secret: string,
): string {
  for (const [label, value] of [
    ['service', service],
    ['account', account],
  ] as const) {
    if (/["\r\n]/.test(value)) {
      throw new Error(
        `Keychain ${label} name must not contain quotes or newlines: ${JSON.stringify(value)}`,
      );
    }
  }
  const hex = Buffer.from(secret, 'utf-8').toString('hex');
  return `add-generic-password -U -s "${service}" -a "${account}" -X ${hex}\n`;
}

/** The config.toml value that points `password` at this account's Keychain item. */
export function keychainRefFor(account: string): string {
  return `keychain:${account}`;
}

/**
 * Whether storeSecretNonInteractive has a backend here.
 *
 * Kept beside that function so the two cannot drift: offering to store a
 * secret on a platform with no backend would fail after the user said yes.
 */
export function keychainSupported(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'darwin' || platform === 'linux';
}

/**
 * Run `security` interactively so the user types the secret into its prompt.
 * stdio is inherited: security owns the terminal for the prompt. Resolves on
 * exit 0, rejects otherwise. The secret never touches this process.
 */
export function runKeychainStore(account: string, service = KEYCHAIN_SERVICE): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('security', buildKeychainStoreArgs(service, account), {
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`security exited with code ${code}`));
    });
  });
}

/**
 * Store a secret this process already holds, without exposing it in argv.
 *
 *   • Linux: `secret-tool store` reads the secret from stdin.
 *   • macOS: `security -i` reads the whole command from stdin (see
 *     buildKeychainStdinCommand); argv is just `-i`.
 */
export async function storeSecretNonInteractive(
  account: string,
  secret: string,
  service = KEYCHAIN_SERVICE,
  osPlatform: NodeJS.Platform = process.platform,
): Promise<void> {
  if (osPlatform === 'linux') {
    return new Promise((resolve, reject) => {
      const child = spawn(
        'secret-tool',
        ['store', '--label', `email-mcp ${account}`, 'service', service, 'account', account],
        { stdio: ['pipe', 'inherit', 'inherit'] },
      );
      child.on('error', reject);
      child.on('close', (code) =>
        code === 0 ? resolve() : reject(new Error(`secret-tool exited with code ${code}`)),
      );
      child.stdin.write(secret);
      child.stdin.end();
    });
  }

  if (osPlatform === 'darwin') {
    const line = buildKeychainStdinCommand(service, account, secret);
    return new Promise((resolve, reject) => {
      const child = spawn('security', ['-i'], { stdio: ['pipe', 'ignore', 'ignore'] });
      child.on('error', reject);
      child.on('close', (code) =>
        code === 0 ? resolve() : reject(new Error(`security exited with code ${code}`)),
      );
      child.stdin.write(line);
      child.stdin.end();
    });
  }

  throw new Error(
    `Keychain storage is supported on macOS and Linux, not "${osPlatform}". Use an "env:<VAR>" reference instead.`,
  );
}
