/**
 * One-shot verification-catch state.
 *
 * Tracks which messages the verification catcher already examined so a code
 * is never re-copied (IDLE replays, reconnect refetches). Marked after the
 * extraction ATTEMPT regardless of outcome — each message costs at most one
 * body fetch, ever. The on-demand tool does not consult this state.
 *
 * Same file-locking pattern as calendar-state.ts, plus pruning: verification
 * traffic churns much faster than calendar mail, so entries expire after
 * 48 h and the file is capped to the newest 1000 entries.
 */

import { mkdir, open, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { VERIFICATION_STATE_FILE } from '../config/xdg.js';

const LOCK_FILE = `${VERIFICATION_STATE_FILE}.lock`;

const MAX_AGE_MS = 48 * 3600 * 1000;
const MAX_ENTRIES = 1000;

interface ProcessedEntry {
  processedAt: string;
  /** Whether the scan actually found a code/link (for inspection only). */
  found: boolean;
}

interface StateFile {
  processedEmails: Record<string, ProcessedEntry>;
}

function stateKey(account: string, mailbox: string, uid: string): string {
  return `${account.replace(/\s+/g, '_')}__${mailbox.replace(/\s+/g, '_')}__${uid}`;
}

async function readState(): Promise<StateFile> {
  try {
    const raw = await readFile(VERIFICATION_STATE_FILE, 'utf8');
    return JSON.parse(raw) as StateFile;
  } catch {
    return { processedEmails: {} };
  }
}

async function writeState(state: StateFile): Promise<void> {
  await mkdir(dirname(VERIFICATION_STATE_FILE), { recursive: true });
  await writeFile(VERIFICATION_STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

/** Drop stale entries and cap total count (newest kept). */
function prune(state: StateFile): StateFile {
  const cutoff = Date.now() - MAX_AGE_MS;
  const entries = Object.entries(state.processedEmails)
    .filter(([, entry]) => {
      const at = Date.parse(entry.processedAt);
      return Number.isNaN(at) ? false : at >= cutoff;
    })
    .sort(([, a], [, b]) => Date.parse(b.processedAt) - Date.parse(a.processedAt))
    .slice(0, MAX_ENTRIES);
  return { processedEmails: Object.fromEntries(entries) };
}

/**
 * Acquire a file-based lock, execute fn, then release.
 * Uses exclusive file creation (O_CREAT | O_EXCL) to prevent concurrent writes.
 */
async function withStateLock<T>(fn: () => Promise<T>): Promise<T> {
  await mkdir(dirname(LOCK_FILE), { recursive: true });

  const acquire = async (retries: number): Promise<Awaited<ReturnType<typeof open>>> => {
    try {
      return await open(LOCK_FILE, 'wx');
    } catch {
      if (retries <= 0) {
        // Stale lock fallback — force acquire after retries exhausted
        return open(LOCK_FILE, 'w');
      }
      return new Promise<Awaited<ReturnType<typeof open>>>((resolve) => {
        setTimeout(() => {
          resolve(acquire(retries - 1));
        }, 50);
      });
    }
  };

  const lockHandle = await acquire(20);

  try {
    return await fn();
  } finally {
    await lockHandle.close();
    await unlink(LOCK_FILE).catch(() => {});
  }
}

/** True when the catcher already examined this message. */
export async function isVerificationProcessed(
  account: string,
  mailbox: string,
  uid: string,
): Promise<boolean> {
  const state = await readState();
  return stateKey(account, mailbox, uid) in state.processedEmails;
}

/** Record that this message was examined (found or not). */
export async function markVerificationProcessed(
  account: string,
  mailbox: string,
  uid: string,
  found: boolean,
): Promise<void> {
  await withStateLock(async () => {
    const state = await readState();
    state.processedEmails[stateKey(account, mailbox, uid)] = {
      processedAt: new Date().toISOString(),
      found,
    };
    await writeState(prune(state));
  });
}
