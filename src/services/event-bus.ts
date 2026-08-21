/**
 * Typed event bus for internal email events.
 *
 * Decouples the IMAP IDLE watcher from MCP notification hooks.
 * Uses Node's built-in EventEmitter with typed event maps.
 */

import { EventEmitter } from 'node:events';
import type { EmailMeta } from '../types/index.js';

// ---------------------------------------------------------------------------
// Event payloads
// ---------------------------------------------------------------------------

export interface NewEmailEvent {
  account: string;
  mailbox: string;
  emails: EmailMeta[];
}

/**
 * A message was removed from a mailbox, by this client or another one.
 *
 * `uid` is only present when the server supports QRESYNC — plain IMAP EXPUNGE
 * reports a sequence number, which is not a stable identity. Consumers that
 * key on UID must treat a missing `uid` as "resynchronize this mailbox"
 * rather than "nothing happened".
 */
export interface ExpungeEvent {
  account: string;
  mailbox: string;
  uid?: number;
  seq?: number;
}

/**
 * Flags changed on a message, possibly from another client.
 *
 * As with {@link ExpungeEvent}, `uid` is absent unless the server supplied it.
 * A consumer that cannot identify the message must resynchronize the mailbox
 * rather than assume its cached flags are still correct.
 */
export interface FlagsEvent {
  account: string;
  mailbox: string;
  uid?: number;
  seq: number;
  flags: string[];
}

/**
 * An IMAP connection was replaced. Anything derived from the previous
 * connection — capability probes, per-account memos, mailbox watermarks —
 * must be revalidated, since the account may now be talking to a different
 * server or a recreated mailbox.
 */
export interface ReconnectEvent {
  account: string;
}

// ---------------------------------------------------------------------------
// Event map
// ---------------------------------------------------------------------------

interface EmailEventMap {
  'email:new': [NewEmailEvent];
  'email:expunge': [ExpungeEvent];
  'email:flags': [FlagsEvent];
  'imap:reconnect': [ReconnectEvent];
}

// ---------------------------------------------------------------------------
// Typed EventBus
// ---------------------------------------------------------------------------

export class EmailEventBus extends EventEmitter<EmailEventMap> {}

/** Singleton event bus shared across the application. */
const eventBus = new EmailEventBus();
export default eventBus;
