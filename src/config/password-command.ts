/**
 * Resolve an account password by executing an external command.
 *
 * Lets users keep secrets in a password manager (Bitwarden CLI, the macOS
 * Keychain, 1Password, ...) instead of in plaintext in config.toml.
 */

import { exec as execCallback } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execCallback);

/** Max wall-clock time a password command may run before it is killed. */
const COMMAND_TIMEOUT_MS = 10_000;

/** Max bytes captured from the child's stdout/stderr. */
const MAX_OUTPUT_BYTES = 1024 * 1024;

/** Max characters of child stderr echoed back in error messages. */
const STDERR_EXCERPT_LIMIT = 400;

/** The subset of an exec rejection we rely on. */
interface CommandFailure {
  killed?: boolean;
  code?: number | string | null;
  stderr?: string;
}

/**
 * Trim and truncate child stderr so it can be safely quoted in an error.
 * The resolved password only ever travels over stdout, never stderr.
 */
function stderrExcerpt(stderr: string | undefined): string {
  const trimmed = (stderr ?? '').trim();
  if (trimmed.length === 0) {
    return '';
  }
  return trimmed.length > STDERR_EXCERPT_LIMIT
    ? `${trimmed.slice(0, STDERR_EXCERPT_LIMIT)}…`
    : trimmed;
}

/**
 * Run the command through the platform shell.
 *
 * `options.env` is deliberately omitted so the child inherits `process.env` —
 * that is how `BW_SESSION`, `OP_SERVICE_ACCOUNT_TOKEN` and `PATH` reach it.
 * `options.stdio` is likewise omitted: exec always gives the child pipes, and
 * inherited fds would corrupt the MCP channel on the stdio transport.
 */
async function runCommand(
  command: string,
  accountName: string,
): Promise<{ stdout: string; stderr: string }> {
  try {
    return await exec(command, {
      encoding: 'utf8',
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BYTES,
      windowsHide: true,
    });
  } catch (error) {
    // Never re-throw the exec error itself: its message embeds the full
    // command line, and for some failure modes the captured stdout too.
    const failure = error as CommandFailure;
    const reason = failure.killed
      ? `timed out after ${COMMAND_TIMEOUT_MS / 1000}s — does it wait for input? Unlock your vault before starting email-mcp.`
      : `exited with code ${String(failure.code ?? 'unknown')}`;
    const detail = stderrExcerpt(failure.stderr);
    throw new Error(
      `password_command for account "${accountName}" ${reason}${detail ? `\n  stderr: ${detail}` : ''}`,
    );
  }
}

/**
 * Execute `command` and return its trimmed stdout as the account password.
 *
 * @param command Shell command line, e.g. `bw get password personal-email`.
 * @param accountName Account the command belongs to, used in error messages.
 */
export default async function resolvePasswordCommand(
  command: string,
  accountName: string,
): Promise<string> {
  const { stdout, stderr } = await runCommand(command, accountName);
  // Password managers print a trailing newline (`bw get password`,
  // `security find-generic-password -w`, `op read`).
  const password = stdout.trim();

  if (password.length === 0) {
    const detail = stderrExcerpt(stderr);
    throw new Error(
      `password_command for account "${accountName}" produced no output on stdout${detail ? `\n  stderr: ${detail}` : ''}`,
    );
  }

  return password;
}
