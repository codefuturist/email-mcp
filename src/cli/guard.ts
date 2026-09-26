/**
 * Guard to prevent interactive prompts from running in non-interactive terminals.
 *
 * When stdin is not a TTY (e.g. piped input, CI, or programmatic execution),
 * @clack/prompts will auto-resolve with default/initial values — which can
 * cause destructive operations (like overwriting config files) without user
 * confirmation. This guard ensures interactive commands fail early and
 * explicitly in non-interactive environments.
 */

import { cancel, isCancel } from '@clack/prompts';

export default function ensureInteractive(): void {
  if (!process.stdin.isTTY) {
    console.error(
      'Error: This command requires an interactive terminal.\n' +
        'Please run it in a terminal with TTY support (not piped or in CI).',
    );
    process.exitCode = 1;
    throw new Error('Non-interactive terminal detected');
  }
}

/** Thrown when the user cancels a prompt; command dispatchers swallow it. */
export class CancelledError extends Error {
  constructor() {
    super('Operation cancelled.');
  }
}

export function assertNotCancel<T>(value: T | symbol): asserts value is T {
  if (isCancel(value)) {
    cancel('Operation cancelled.');
    throw new CancelledError();
  }
}
