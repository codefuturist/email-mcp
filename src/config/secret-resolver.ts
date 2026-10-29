/**
 * Secret indirection for account credentials — keeps plaintext out of
 * config.toml. A config value may be:
 *
 *   • a plain string            → used as-is (backward compatible)
 *   • "keychain:<account>"      → macOS Keychain, service "email-mcp"
 *   • "keychain:<svc>/<account>"→ macOS Keychain, explicit service
 *   • "env:<VAR>"               → an environment variable
 *
 * The Keychain path shells out to the `security` CLI. Only the service and
 * account (non-secret identifiers) are ever passed as arguments — the secret
 * itself only ever travels back on the child's stdout, so nothing sensitive
 * reaches argv (visible via `ps`) or the logs. Multi-account falls out of the
 * Keychain's per-item `account` attribute: each account's secret is a distinct
 * generic-password item under the shared service.
 *
 * Writing a secret is deliberately NOT done here — see `account set-secret`,
 * which delegates entry to the `security` interactive prompt so the value is
 * never scripted into argv.
 */

import { execFile } from 'node:child_process';
import { platform } from 'node:os';

const DEFAULT_SERVICE = 'email-mcp';
const KEYCHAIN_PREFIX = 'keychain:';
const ENV_PREFIX = 'env:';

/** Is this config value an indirection (`keychain:`/`env:`) rather than the secret itself? */
export function isSecretReference(value: string): boolean {
  return value.startsWith(KEYCHAIN_PREFIX) || value.startsWith(ENV_PREFIX);
}

/** Injectable reader: (command, args) => secret on stdout. */
export type SecretRunner = (command: string, args: string[]) => Promise<string>;

export interface ResolveOptions {
  runner?: SecretRunner;
  env?: Record<string, string | undefined>;
  /** Override the detected platform (testing / explicit control). */
  platform?: NodeJS.Platform;
}

/** Default runner: read a generic password from the macOS Keychain. */
const securityRunner: SecretRunner = (command, args) =>
  new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 10_000 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr?.trim() || err.message));
        return;
      }
      resolve(stdout);
    });
  });

function parseKeychainRef(ref: string): { service: string; account: string } {
  const body = ref.slice(KEYCHAIN_PREFIX.length);
  if (!body) {
    throw new Error(
      'Invalid keychain reference: expected "keychain:<account>" or "keychain:<service>/<account>".',
    );
  }
  const slash = body.indexOf('/');
  if (slash === -1) {
    return { service: DEFAULT_SERVICE, account: body };
  }
  const service = body.slice(0, slash);
  const account = body.slice(slash + 1);
  if (!service || !account) {
    throw new Error(`Invalid keychain reference "${ref}": both service and account are required.`);
  }
  return { service, account };
}

/**
 * Resolve one config secret value. Plain strings pass through unchanged, so
 * existing plaintext configs keep working while new ones can point at the
 * Keychain or an environment variable.
 */
export async function resolveSecret(value: string, opts: ResolveOptions = {}): Promise<string> {
  const env = opts.env ?? process.env;

  if (value.startsWith(ENV_PREFIX)) {
    const name = value.slice(ENV_PREFIX.length);
    const resolved = env[name];
    if (resolved === undefined || resolved === '') {
      throw new Error(`Secret env var ${name} is not set (referenced as "${value}").`);
    }
    return resolved;
  }

  if (value.startsWith(KEYCHAIN_PREFIX)) {
    const os = opts.platform ?? platform();
    const { service, account } = parseKeychainRef(value);

    // macOS → `security`; Linux → libsecret `secret-tool`. Both receive only
    // the non-secret service/account identifiers; the secret returns on stdout.
    let command: string;
    let args: string[];
    if (os === 'darwin') {
      command = 'security';
      args = ['find-generic-password', '-s', service, '-a', account, '-w'];
    } else if (os === 'linux') {
      command = 'secret-tool';
      args = ['lookup', 'service', service, 'account', account];
    } else {
      throw new Error(
        `Keychain references are supported on macOS (security) and Linux (libsecret secret-tool), ` +
          `not "${os}". Store the secret in an environment variable and use "env:<VAR>" instead.`,
      );
    }

    const runner = opts.runner ?? securityRunner;
    let secret: string;
    try {
      secret = await runner(command, args);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const how =
        os === 'darwin'
          ? `email-mcp account set-secret ${account}`
          : `secret-tool store --label="email-mcp ${account}" service ${service} account ${account}`;
      throw new Error(
        `Could not read secret for account "${account}" from the keychain ` +
          `(service "${service}"): ${msg}. Store it with: ${how}`,
      );
    }
    return secret.replace(/\r?\n$/, '');
  }

  return value;
}
