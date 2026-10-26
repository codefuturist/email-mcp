/**
 * IMAP service — pure business logic for email read operations.
 *
 * No MCP dependency — fully unit-testable.
 */

import { randomUUID } from 'node:crypto';
import type { ImapFlow } from 'imapflow';
import libmime from 'libmime';
import type { IConnectionManager } from '../connections/types.js';
import {
  assertAllowedExtension,
  assertSafeDownloadBasename,
  resolveAttachmentDownloadPath,
  sanitizeAttachmentBasename,
  writeDownloadFileAtomic,
} from '../safety/attachment-download.js';
import {
  safeAttachmentFilename,
  sanitizeMailboxName,
  sanitizeSearchQuery,
} from '../safety/validation.js';
import type {
  AccountConfig,
  AttachmentDownloadConfig,
  AttachmentMeta,
  BulkResult,
  Contact,
  DailyVolume,
  Email,
  EmailAddress,
  EmailMeta,
  EmailStats,
  LabelInfo,
  Mailbox,
  MailboxSnapshot,
  PaginatedResult,
  QuotaInfo,
  SenderStat,
  SentCopyResult,
} from '../types/index.js';
import { unflowFormatFlowed } from '../utils/body-format.js';
import { buildPreview, findPreviewPart, PREVIEW_PART_BYTES } from '../utils/body-preview.js';
import { BULK_HEADER_FIELDS, classifyBulk } from '../utils/bulk-headers.js';
import { stripHtml } from '../utils/html.js';
import { imapCommand } from '../utils/imap-error.js';
import type { ReconnectEvent } from './event-bus.js';
import eventBus from './event-bus.js';
import type { LabelStrategy } from './label-strategy.js';
import { detectLabelStrategy } from './label-strategy.js';
import {
  collectTextParts,
  describeUndisplayableStructure,
  extractAttachments,
  findDeliveryStatusPart,
  findMimePartByFilename,
  hasAttachments,
  parseHeaders,
  selectBodyParts,
  splitMimeType,
  type TextPart,
} from './mime-structure.js';

// ---------------------------------------------------------------------------
// Helpers (must be defined before ImapService)
// ---------------------------------------------------------------------------

function parseAddress(addr: { name?: string; address?: string } | undefined): EmailAddress {
  return {
    name: addr?.name ?? undefined,
    address: addr?.address ?? 'unknown',
  };
}

/** Exported so the cached read path produces addresses identically. */
export function parseAddresses(
  addrs: { name?: string; address?: string }[] | undefined,
): EmailAddress[] {
  if (!addrs) return [];
  return addrs.map(parseAddress);
}

/** Decode the preview from an already-fetched body part, when one is present. */
function previewFromMessage(msg: Record<string, unknown>): string | undefined {
  const parts = msg.bodyParts as Map<string, Buffer> | undefined;
  if (!parts) {
    return undefined;
  }
  try {
    const part = findPreviewPart(msg.bodyStructure);
    const raw = part ? parts.get(part.key) : undefined;
    return part && raw ? buildPreview(raw, part) : undefined;
  } catch {
    // The body is sender-controlled; decoding it is a convenience, not the
    // request. One malformed message must never fail an entire listing page
    // over a preview nobody can act on anyway.
    return undefined;
  }
}

/**
 * Fill in previews for the messages whose text sits at section 1.1.
 *
 * This needs its own fetch restricted to those UIDs: asking for a section a
 * message does not have fails the entire batch on Gmail, so 1.1 cannot simply
 * be added to the first request.
 */
async function fetchNestedPreviews(
  client: ImapFlow,
  messages: Record<string, unknown>[],
): Promise<void> {
  const byUid = new Map<number, Record<string, unknown>>();
  messages.forEach((msg) => {
    if (findPreviewPart(msg.bodyStructure)?.key === '1.1') {
      byUid.set(msg.uid as number, msg);
    }
  });
  if (byUid.size === 0) {
    return;
  }

  // eslint-disable-next-line no-restricted-syntax
  for await (const msg of client.fetch(
    [...byUid.keys()].join(','),
    { uid: true, bodyParts: [{ key: '1.1', start: 0, maxLength: PREVIEW_PART_BYTES }] },
    { uid: true },
  )) {
    const target = byUid.get(msg.uid);
    if (target) {
      target.bodyParts = msg.bodyParts;
    }
  }
}

/**
 * Map a raw ImapFlow fetch result to `EmailMeta`.
 *
 * Exported so the IDLE watcher shares one definition — a second, slightly
 * different implementation there previously produced inconsistent records for
 * the same message.
 */
export function messageToEmailMeta(msg: Record<string, unknown>): EmailMeta {
  const envelope = (msg.envelope ?? {}) as Record<string, unknown>;
  const flags = new Set((msg.flags ?? []) as string[]);

  // Extract non-system flags as labels (IMAP keywords)
  const labels = [...flags].filter((f) => !f.startsWith('\\'));

  // Every fetch in this service passes `{ uid: true }`, so a missing UID means
  // the server broke protocol. Falling back to `msg.seq` would mint an id that
  // looks like a UID but addresses a different message on every subsequent
  // write — fail loudly instead.
  if (typeof msg.uid !== 'number') {
    throw new Error(
      `IMAP server returned a message without a UID (seq ${String(msg.seq ?? 'unknown')})`,
    );
  }

  return {
    id: String(msg.uid),
    subject: (envelope.subject as string) ?? '(no subject)',
    from: parseAddress((envelope.from as Record<string, string>[])?.[0]),
    to: parseAddresses(envelope.to as Record<string, string>[]),
    date: envelope.date
      ? new Date(envelope.date as string).toISOString()
      : new Date().toISOString(),
    seen: flags.has('\\Seen'),
    flagged: flags.has('\\Flagged'),
    answered: flags.has('\\Answered'),
    hasAttachments: hasAttachments(msg.bodyStructure),
    labels,
    // Only set when the caller opted into the preview (listEmails/searchEmails
    // `preview: true`) and requested bodyParts accordingly; undefined
    // otherwise, including for the IDLE watcher's shared use of this mapper.
    preview: previewFromMessage(msg),
    bulk: Buffer.isBuffer(msg.headers) ? classifyBulk(parseHeaders(msg.headers)) : undefined,
  };
}

/**
 * Cap on a single downloaded body part. Checked against the BODYSTRUCTURE
 * size, which is the encoded octet count — conservative, since encoded is
 * never smaller than decoded.
 */
const BODY_PART_MAX_BYTES = 512 * 1024;

/**
 * Reject a header value containing a line break.
 *
 * `saveDraft` assembles an RFC 822 message by hand, so a CR or LF in a value
 * injects arbitrary headers or terminates the header block early.
 */
function assertNoCrlf(value: string, field: string): void {
  if (/[\r\n]/.test(value)) {
    throw new Error(`${field} must not contain a line break`);
  }
}

/**
 * Base64-encode a body, wrapped at the 76 columns RFC 2045 allows.
 *
 * Drafts are appended as hand-built messages, and a header block declaring
 * `charset=utf-8` with no Content-Transfer-Encoding means 7bit — so an umlaut
 * in the body made the message claim one thing and carry another. Base64
 * sidesteps the question for every byte a composer can produce.
 */
function base64Body(text: string): string {
  const encoded = Buffer.from(text, 'utf-8').toString('base64');
  return (encoded.match(/.{1,76}/g) ?? []).join('\r\n');
}

/**
 * Format a From header, encoding a non-ASCII display name.
 *
 * An RFC 2047 encoded word may not appear inside a quoted string, so a name
 * that needed encoding is emitted bare and an ASCII one keeps its quotes —
 * which is what makes a comma inside the name safe.
 */
function formatFromHeader(fullName: string | undefined, email: string): string {
  if (!fullName) return email;
  const encoded = libmime.encodeWords(fullName);
  return encoded === fullName ? `"${fullName}" <${email}>` : `${encoded} <${email}>`;
}

/**
 * Download one body part, transfer-decoded by ImapFlow, bounded by `maxBytes`
 * (BODY_PART_MAX_BYTES by default). Past the cap the stream is still drained to
 * the end — destroying an ImapFlow download stream mid-command corrupts the
 * connection's command state — but only the first cap bytes are kept.
 */
async function downloadBodyPart(
  client: ImapFlow,
  uid: number,
  path: TextPart['path'],
  subtype?: string,
  maxBytes: number = BODY_PART_MAX_BYTES,
): Promise<string | undefined> {
  try {
    const part = await client.download(String(uid), path, { uid: true });
    if (!part?.content) return undefined;

    const chunks: Buffer[] = [];
    let kept = 0;
    let truncated = false;
    // eslint-disable-next-line no-restricted-syntax
    for await (const chunk of part.content) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const room = maxBytes - kept;
      if (room > 0) {
        chunks.push(buf.length > room ? buf.subarray(0, room) : buf);
        kept += Math.min(buf.length, room);
      }
      if (buf.length > room) truncated = true;
    }
    let raw = Buffer.concat(chunks);

    // A cut at an arbitrary byte can land inside a multibyte character, whose
    // remaining bytes then decode to U+FFFD. Back off to the last codepoint
    // boundary — a lead byte is 0b0xxxxxxx or 0b11xxxxxx, continuations are
    // 0b10xxxxxx.
    if (truncated) {
      for (let back = 0; back < 4 && raw.length - back > 0; back += 1) {
        const byte = raw[raw.length - 1 - back] as number;
        if ((byte & 0b1100_0000) !== 0b1000_0000) {
          const seqLen =
            // biome-ignore format: the width ladder reads better aligned
            byte < 0x80 ? 1 : byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
          // Keep the sequence only when all of its bytes survived the cut.
          if (back + 1 < seqLen) raw = raw.subarray(0, raw.length - 1 - back);
          break;
        }
      }
    }

    // ImapFlow charset-converts text/plain and text/html only (its isTextNode
    // list), so any other text subtype — text/calendar, text/enriched —
    // arrives as raw bytes with the declared charset in meta.
    const charset = (part.meta as Record<string, unknown> | undefined)?.charset as
      | string
      | undefined;
    const needsDecode = subtype !== undefined && subtype !== 'plain' && subtype !== 'html';
    let decoded: string;
    if (needsDecode && charset) {
      try {
        decoded = new TextDecoder(charset).decode(raw);
      } catch {
        // Unknown charset label — utf-8 is the least-wrong fallback.
        decoded = raw.toString('utf-8');
      }
    } else {
      decoded = raw.toString('utf-8');
    }

    return truncated
      ? `${decoded}\n…[body truncated at ${Math.round(maxBytes / 1024)} KB]`
      : decoded;
  } catch (err) {
    // Part may not exist on this server — better an empty body than a throw,
    // but not a silent one. stderr is safe under the stdio transport.
    process.stderr.write(
      `email-mcp: body part ${path} of uid ${uid} failed to download: ${
        err instanceof Error ? err.message : String(err)
      }\n`,
    );
    return undefined;
  }
}

/**
 * Download every part of one body group and join them into a single body.
 *
 * multipart/mixed splits running text across sibling parts, so a group can hold
 * more than one; they are concatenated in document order with a blank line
 * between, which is also what keeps the last word of one part off the first
 * word of the next. BODY_PART_MAX_BYTES is a budget for the whole group rather
 * than per part, so a message with many large parts cannot multiply past it.
 */
async function downloadBodyGroup(
  client: ImapFlow,
  uid: number,
  parts: TextPart[],
): Promise<string | undefined> {
  const pieces: string[] = [];
  let budget = BODY_PART_MAX_BYTES;

  // eslint-disable-next-line no-restricted-syntax
  for (const part of parts) {
    if (budget <= 0) {
      pieces.push('…[remaining body parts omitted at 512 KB]');
      break;
    }
    // Sequential by necessity: ImapFlow serialises commands on one connection,
    // so issuing these in parallel only queues them behind each other.
    // eslint-disable-next-line no-await-in-loop
    const text = await downloadBodyPart(client, uid, part.path, part.subtype, budget);
    if (text !== undefined) {
      // Unwrap here rather than at render time: the flag belongs to this part,
      // and every later consumer — the cache, the tools, the CLI — then reads
      // one already-readable body.
      pieces.push(part.flowed ? unflowFormatFlowed(text, part.delSp) : text);
      budget -= Buffer.byteLength(text, 'utf-8');
    }
  }

  return pieces.length > 0 ? pieces.join('\n\n') : undefined;
}

async function messageToEmail(
  msg: Record<string, unknown>,
  client: ImapFlow,
  uid: number,
): Promise<Email> {
  const meta = messageToEmailMeta(msg);
  const envelope = (msg.envelope ?? {}) as Record<string, unknown>;

  let bodyText: string | undefined;
  let bodyHtml: string | undefined;

  // Headers come from a HEADER fetch. `source` would work too, but it pulls
  // the entire message — base64 attachments and all — to read a few hundred
  // bytes of header.
  const headers = parseHeaders(msg.headers);

  // Always download body parts; never read them out of `source`. Raw source
  // is transfer-encoded (quoted-printable, base64) with soft line breaks, so
  // using it directly yields "=3D" for '=' and words split mid-token.
  // download() applies the decoding declared by Content-Transfer-Encoding.
  // selectBodyParts settles both the over-cap and the stub-plain trade-offs,
  // in that order, given the per-group transfer ceiling.
  const { plain, html } = selectBodyParts(collectTextParts(msg.bodyStructure), BODY_PART_MAX_BYTES);

  if (plain.length > 0) bodyText = await downloadBodyGroup(client, uid, plain);
  if (html.length > 0) bodyHtml = await downloadBodyGroup(client, uid, html);

  if (bodyText === undefined && bodyHtml === undefined) {
    // No displayable part at all — S/MIME and PGP payloads land here. A
    // labeled placeholder beats the bare "(no content)" the tool layer shows.
    bodyText = describeUndisplayableStructure(msg.bodyStructure);
  }

  // Bounces carry their actual status codes in a machine-readable part that
  // is not text/* and would otherwise never be surfaced. It gets its own
  // field rather than being appended to bodyText: the human-readable
  // explanation is often the HTML part, and applyBodyFormat prefers bodyText,
  // so appending there would show the status block and hide the reason.
  let deliveryStatus: string | undefined;
  const statusPath = findDeliveryStatusPart(msg.bodyStructure);
  if (statusPath) {
    const status = await downloadBodyPart(client, uid, statusPath);
    if (status?.trim()) {
      deliveryStatus = status.trim();
    }
  }

  return {
    ...meta,
    cc: parseAddresses(envelope.cc as Record<string, string>[]),
    bcc: parseAddresses(envelope.bcc as Record<string, string>[]),
    bodyText,
    bodyHtml,
    messageId: (envelope.messageId as string) ?? '',
    inReplyTo: (envelope.inReplyTo as string) ?? undefined,
    references: headers.references?.split(/\s+/).filter(Boolean),
    attachments: extractAttachments(msg.bodyStructure),
    headers,
    deliveryStatus,
    // Recomputed from the full header set rather than reusing meta.bulk: a
    // single/thread fetch carries every header, so this is strictly more
    // complete than the targeted HEADER.FIELDS subset a listing fetch uses.
    bulk: classifyBulk(headers),
  };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/** The slice of the local mirror search needs — kept structural for testing. */
interface SearchCache {
  searchMessages(
    account: string,
    mailbox: string,
    uidValidity: string,
    query: string,
    limit?: number,
  ): { uid: number }[];
}

export default class ImapService {
  private labelStrategies = new Map<string, LabelStrategy>();

  /** Optional local mirror used to supplement live text search. */
  private cacheStore?: SearchCache;

  private labelStrategyPending = new Map<string, Promise<LabelStrategy>>();

  private readonly onReconnect: (event: ReconnectEvent) => void;

  constructor(private connections: IConnectionManager) {
    // The label strategy is probed from server capabilities and folder layout,
    // so it is only valid for the connection that produced it. A reconnect may
    // reach a different server for the same account — drop the memo and
    // re-detect on next use.
    this.onReconnect = ({ account }) => {
      this.labelStrategies.delete(account);
      this.labelStrategyPending.delete(account);
    };
    eventBus.on('imap:reconnect', this.onReconnect);
  }

  /**
   * Attach the local mirror so text searches can also match what only the
   * cache knows — attachment filenames and porter-stemmed full text.
   */
  setCacheStore(store: SearchCache): void {
    this.cacheStore = store;
  }

  /**
   * Detach from the event bus.
   *
   * The server holds a single long-lived instance, so this matters mainly for
   * tests and for any future code that builds a service graph per request —
   * without it each instance leaks a listener on the shared bus.
   */
  dispose(): void {
    eventBus.off('imap:reconnect', this.onReconnect);
  }

  /**
   * Lock a caller-supplied mailbox path.
   *
   * Trims and rejects the IMAP wildcards `*` and `%` first. Prefer this over
   * `client.getMailboxLock()` for any path that originated outside this
   * process — it keeps validation from drifting method by method, and
   * normalizes the path so " INBOX " and "INBOX" address one mailbox.
   *
   * Paths returned by `client.list()` are server-supplied and already valid;
   * those may be locked directly.
   */
  private static lockMailbox(client: ImapFlow, mailbox: string) {
    const path = sanitizeMailboxName(mailbox);
    // Every read and write opens a mailbox first, so this is the most common
    // place a server refusal surfaces — and the least useful one to report as
    // a bare "Command failed".
    return imapCommand(`Opening mailbox "${path}"`, () => client.getMailboxLock(path));
  }

  private async getLabelStrategy(accountName: string): Promise<LabelStrategy> {
    const cached = this.labelStrategies.get(accountName);
    if (cached) return cached;

    // Deduplicate concurrent detection for the same account
    const pending = this.labelStrategyPending.get(accountName);
    if (pending) return pending;

    const promise = (async () => {
      try {
        const client = await this.connections.getImapClient(accountName);
        const strategy = await detectLabelStrategy(client);
        this.labelStrategies.set(accountName, strategy);
        return strategy;
      } finally {
        // Cleared on settle, not on success. A rejected promise left in the
        // map is handed to every later caller, so one transient IMAP failure
        // during detection would break every label operation for the account
        // until the process restarts.
        this.labelStrategyPending.delete(accountName);
      }
    })();

    this.labelStrategyPending.set(accountName, promise);
    return promise;
  }

  // -------------------------------------------------------------------------
  // Mailboxes
  // -------------------------------------------------------------------------

  async listMailboxes(accountName: string): Promise<Mailbox[]> {
    const client = await this.connections.getImapClient(accountName);
    const mailboxes = await client.list();

    const statusResults = await Promise.allSettled(
      mailboxes.map(async (mb) => {
        const status = await client.status(mb.path, {
          messages: true,
          unseen: true,
        });
        // imapflow's status() returns `false` when the STATUS call is refused
        // (e.g. a \Noselect folder); leave counts undefined in that case.
        return {
          name: mb.name,
          path: mb.path,
          specialUse: mb.specialUse ?? undefined,
          totalMessages: status ? status.messages : undefined,
          unseenMessages: status ? status.unseen : undefined,
        };
      }),
    );

    return statusResults.map((result, idx) => {
      if (result.status === 'fulfilled') {
        return result.value;
      }
      // STATUS failed — either the folder doesn't support it (e.g. \Noselect) or
      // the connection is degraded. Leave the counts undefined rather than
      // reporting 0: a caller (or the cache) must not mistake this for an empty
      // mailbox.
      const mb = mailboxes[idx]; // parallel to statusResults (same source array)
      return {
        name: mb?.name ?? '',
        path: mb?.path ?? '',
        specialUse: mb?.specialUse ?? undefined,
        totalMessages: undefined,
        unseenMessages: undefined,
      };
    });
  }

  /**
   * One cheap STATUS round trip, used by the cached read path as its
   * freshness probe (compare against the mirror's stored watermarks — the
   * IMAP equivalent of a conditional request).
   */
  async getMailboxStatus(
    accountName: string,
    mailbox: string,
  ): Promise<{
    uidValidity?: string;
    uidNext?: number;
    highestModseq?: string;
    messages?: number;
  }> {
    const client = await this.connections.getImapClient(accountName);
    const status = (await client.status(sanitizeMailboxName(mailbox), {
      uidValidity: true,
      uidNext: true,
      highestModseq: true,
      messages: true,
    })) as {
      uidValidity?: bigint;
      uidNext?: number;
      highestModseq?: bigint;
      messages?: number;
    };

    return {
      uidValidity: status.uidValidity?.toString(),
      uidNext: status.uidNext,
      highestModseq: status.highestModseq?.toString(),
      messages: status.messages,
    };
  }

  // -------------------------------------------------------------------------
  // List emails
  // -------------------------------------------------------------------------

  async listEmails(
    accountName: string,
    options: {
      mailbox?: string;
      page?: number;
      pageSize?: number;
      since?: string;
      before?: string;
      from?: string;
      subject?: string;
      seen?: boolean;
      flagged?: boolean;
      hasAttachment?: boolean;
      answered?: boolean;
      /** Fetch and decode a short body preview. Costs extra bytes per message. */
      preview?: boolean;
    } = {},
  ): Promise<PaginatedResult<EmailMeta>> {
    const client = await this.connections.getImapClient(accountName);
    const mailbox = sanitizeMailboxName(options.mailbox ?? 'INBOX');
    const page = options.page ?? 1;
    const pageSize = options.pageSize ?? 20;

    const lock = await ImapService.lockMailbox(client, mailbox);
    try {
      // Build search criteria
      const search: Record<string, unknown> = {};
      if (options.since) search.since = new Date(options.since);
      if (options.before) search.before = new Date(options.before);
      if (options.from) search.from = options.from;
      if (options.subject) search.subject = options.subject;
      if (options.seen !== undefined) search.seen = options.seen;
      if (options.flagged !== undefined) search.flagged = options.flagged;
      if (options.answered !== undefined) search.answered = options.answered;

      // Unfiltered listings need only the requested sequence window, not a
      // SEARCH ALL response containing every UID in a large mailbox. Capture
      // UIDs first so subsequent fetches still use stable identifiers.
      let pageTotal: number | undefined;
      let uids: number[] = [];
      if (
        Object.keys(search).length === 0 &&
        options.hasAttachment === undefined &&
        client.mailbox
      ) {
        pageTotal = client.mailbox.exists;
        const end = pageTotal - (page - 1) * pageSize;
        if (end > 0) {
          for await (const msg of client.fetch(`${Math.max(1, end - pageSize + 1)}:${end}`, {
            uid: true,
          })) {
            uids.push(msg.uid);
          }
        }
      } else {
        const searchResult = await client.search(search, { uid: true });
        uids = Array.isArray(searchResult) ? searchResult : [];
      }

      // Post-filter for hasAttachment (IMAP has no native attachment search)
      if (options.hasAttachment !== undefined && uids.length > 0) {
        const filteredUids: number[] = [];
        // eslint-disable-next-line no-restricted-syntax
        for await (const msg of client.fetch(
          uids.join(','),
          { uid: true, bodyStructure: true },
          { uid: true },
        )) {
          const raw = msg as unknown as Record<string, unknown>;
          if (options.hasAttachment === hasAttachments(raw.bodyStructure)) {
            filteredUids.push(raw.uid as number);
          }
        }
        uids = filteredUids;
      }

      if (uids.length === 0) {
        return {
          items: [],
          total: pageTotal ?? 0,
          page,
          pageSize,
          hasMore: false,
        };
      }

      // Sort descending (newest first) and paginate
      uids.sort((a, b) => b - a);
      const total = pageTotal ?? uids.length;
      const start = pageTotal === undefined ? (page - 1) * pageSize : 0;
      const pageUids = uids.slice(start, start + pageSize);

      if (pageUids.length === 0) {
        return {
          items: [],
          total,
          page,
          pageSize,
          hasMore: false,
        };
      }

      const items: EmailMeta[] = [];
      const raw: Record<string, unknown>[] = [];
      const range = pageUids.join(',');

      // eslint-disable-next-line no-restricted-syntax
      for await (const msg of client.fetch(
        range,
        {
          uid: true,
          envelope: true,
          flags: true,
          bodyStructure: true,
          // Targeted field fetch for bulk-mail classification — cheap enough
          // to run over a whole page; see classifyBulk.
          headers: BULK_HEADER_FIELDS,
          ...(options.preview
            ? { bodyParts: [{ key: '1', start: 0, maxLength: PREVIEW_PART_BYTES }] }
            : {}),
        },
        { uid: true },
      )) {
        raw.push(msg as unknown as Record<string, unknown>);
      }

      if (options.preview) {
        await fetchNestedPreviews(client, raw);
      }

      raw.forEach((msg) => {
        items.push(messageToEmailMeta(msg));
      });

      // Sort by date descending
      items.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

      return {
        items,
        total,
        page,
        pageSize,
        hasMore: page * pageSize < total,
      };
    } finally {
      lock.release();
    }
  }

  // -------------------------------------------------------------------------
  // Get single email
  // -------------------------------------------------------------------------

  async getEmail(accountName: string, emailId: string, mailbox = 'INBOX'): Promise<Email> {
    const client = await this.connections.getImapClient(accountName);
    const uid = parseInt(emailId, 10);
    const safeMailbox = sanitizeMailboxName(mailbox);

    const lock = await client.getMailboxLock(safeMailbox);
    try {
      const msg = await client.fetchOne(
        String(uid),
        {
          uid: true,
          envelope: true,
          flags: true,
          bodyStructure: true,
          // Headers only. `source: true` would transfer the whole message,
          // attachments included, to read a few hundred bytes of header —
          // the body arrives separately as a decoded MIME part.
          headers: true,
        },
        { uid: true },
      );

      if (!msg) {
        throw new Error(`Email ${emailId} not found in ${mailbox}`);
      }

      return await messageToEmail(msg as unknown as Record<string, unknown>, client, uid);
    } finally {
      lock.release();
    }
  }

  // -------------------------------------------------------------------------
  // Get email flags (lightweight — no body fetch, no \Seen change)
  // -------------------------------------------------------------------------

  async getEmailFlags(
    accountName: string,
    emailId: string,
    mailbox = 'INBOX',
  ): Promise<{
    seen: boolean;
    flagged: boolean;
    answered: boolean;
    labels: string[];
    subject: string;
    from: string;
    date: string;
  }> {
    const client = await this.connections.getImapClient(accountName);
    const uid = parseInt(emailId, 10);

    const lock = await ImapService.lockMailbox(client, mailbox);
    try {
      const msg = await client.fetchOne(
        String(uid),
        { uid: true, envelope: true, flags: true },
        { uid: true },
      );

      if (!msg) {
        throw new Error(`Email ${emailId} not found in ${mailbox}`);
      }

      const raw = msg as unknown as Record<string, unknown>;
      const flags = new Set((raw.flags ?? []) as string[]);
      const labels = [...flags].filter((f) => !f.startsWith('\\'));
      const envelope = (raw.envelope ?? {}) as Record<string, unknown>;
      const fromEntry = (envelope.from as Record<string, string>[] | undefined)?.[0];
      let from = '';
      if (fromEntry) {
        from = fromEntry.name
          ? `${fromEntry.name} <${fromEntry.address}>`
          : (fromEntry.address ?? '');
      }

      return {
        seen: flags.has('\\Seen'),
        flagged: flags.has('\\Flagged'),
        answered: flags.has('\\Answered'),
        labels,
        subject: (envelope.subject as string) ?? '(no subject)',
        from,
        date: envelope.date ? new Date(envelope.date as string).toISOString() : '',
      };
    } finally {
      lock.release();
    }
  }

  // -------------------------------------------------------------------------
  // Search emails
  // -------------------------------------------------------------------------

  async searchEmails(
    accountName: string,
    query: string,
    options: {
      mailbox?: string;
      page?: number;
      pageSize?: number;
      from?: string;
      to?: string;
      since?: string;
      before?: string;
      sentSince?: string;
      sentBefore?: string;
      hasAttachment?: boolean;
      largerThan?: number;
      smallerThan?: number;
      answered?: boolean;
      /** Fetch and decode a short body preview. Costs extra bytes per message. */
      preview?: boolean;
    } = {},
  ): Promise<PaginatedResult<EmailMeta>> {
    const client = await this.connections.getImapClient(accountName);
    const mailbox = sanitizeMailboxName(options.mailbox ?? 'INBOX');
    const page = options.page ?? 1;
    const pageSize = options.pageSize ?? 20;
    const sanitizedQuery = query ? sanitizeSearchQuery(query) : '';

    // Reject "no query and no filters" — IMAP would return the entire mailbox,
    // which silently turns search_emails into list_emails. Force callers to be
    // explicit; if they really want everything they should call list_emails.
    const hasAnyFilter =
      !!sanitizedQuery ||
      !!options.from ||
      !!options.to ||
      !!options.since ||
      !!options.before ||
      !!options.sentSince ||
      !!options.sentBefore ||
      options.hasAttachment !== undefined ||
      options.largerThan !== undefined ||
      options.smallerThan !== undefined ||
      options.answered !== undefined;
    if (!hasAnyFilter) {
      throw new Error(
        'search_emails requires at least one of: query, from, to, since, before, sent_since, ' +
          'sent_before, has_attachment, larger_than, smaller_than, answered. Use list_emails to ' +
          'browse a mailbox without filters.',
      );
    }

    const lock = await ImapService.lockMailbox(client, mailbox);
    try {
      // Build search criteria — base query OR across subject/from/body
      const baseCriteria: Record<string, unknown> = sanitizedQuery
        ? { or: [{ subject: sanitizedQuery }, { from: sanitizedQuery }, { body: sanitizedQuery }] }
        : {};

      // Build additional filters as AND conditions
      const andConditions: Record<string, unknown>[] = [baseCriteria];

      if (options.from) {
        andConditions.push({ from: options.from });
      }
      if (options.to) {
        andConditions.push({ to: options.to });
      }
      if (options.since) {
        andConditions.push({ since: new Date(options.since) });
      }
      if (options.before) {
        andConditions.push({ before: new Date(options.before) });
      }
      if (options.sentSince) {
        andConditions.push({ sentSince: new Date(options.sentSince) });
      }
      if (options.sentBefore) {
        andConditions.push({ sentBefore: new Date(options.sentBefore) });
      }
      if (options.largerThan !== undefined) {
        andConditions.push({ larger: options.largerThan * 1024 });
      }
      if (options.smallerThan !== undefined) {
        andConditions.push({ smaller: options.smallerThan * 1024 });
      }
      if (options.answered === true) {
        andConditions.push({ answered: true });
      } else if (options.answered === false) {
        andConditions.push({ answered: false });
      }

      // Use the combined criteria or just the base
      const searchCriteria =
        andConditions.length === 1 ? baseCriteria : Object.assign({}, ...andConditions);

      const searchResult = await client.search(searchCriteria, { uid: true });
      let uids: number[] = Array.isArray(searchResult) ? searchResult : [];

      // Supplement with local-mirror FTS hits: it matches what IMAP SEARCH
      // cannot (attachment filenames, stemmed terms) and only ever ADDS
      // results. Skipped when structured filters are active — the cache
      // cannot evaluate them, so a union would leak non-matching messages.
      const structuredFiltersActive =
        options.from !== undefined ||
        options.to !== undefined ||
        options.since !== undefined ||
        options.before !== undefined ||
        options.sentSince !== undefined ||
        options.sentBefore !== undefined ||
        options.largerThan !== undefined ||
        options.smallerThan !== undefined ||
        options.answered !== undefined;
      if (sanitizedQuery && this.cacheStore && !structuredFiltersActive) {
        const mb = client.mailbox;
        const uidValidity =
          typeof mb === 'object' && mb.uidValidity !== undefined ? String(mb.uidValidity) : '';
        if (uidValidity) {
          const known = new Set(uids);
          for (const hit of this.cacheStore.searchMessages(
            accountName,
            mailbox,
            uidValidity,
            sanitizedQuery,
          )) {
            if (!known.has(hit.uid)) uids.push(hit.uid);
          }
        }
      }

      // Post-filter for has_attachment if requested (IMAP doesn't have native support)
      if (options.hasAttachment !== undefined && uids.length > 0) {
        const filteredUids: number[] = [];
        const checkRange = uids.join(',');

        // eslint-disable-next-line no-restricted-syntax
        for await (const msg of client.fetch(
          checkRange,
          { uid: true, bodyStructure: true },
          { uid: true },
        )) {
          const raw = msg as unknown as Record<string, unknown>;
          const msgHasAtt = hasAttachments(raw.bodyStructure);
          if (options.hasAttachment === msgHasAtt) {
            filteredUids.push(raw.uid as number);
          }
        }

        uids = filteredUids;
      }

      if (uids.length === 0) {
        return {
          items: [],
          total: 0,
          page,
          pageSize,
          hasMore: false,
        };
      }

      uids.sort((a, b) => b - a);
      const total = uids.length;
      const start = (page - 1) * pageSize;
      const pageUids = uids.slice(start, start + pageSize);

      if (pageUids.length === 0) {
        return {
          items: [],
          total,
          page,
          pageSize,
          hasMore: false,
        };
      }

      const items: EmailMeta[] = [];
      const raw: Record<string, unknown>[] = [];
      const range = pageUids.join(',');

      // eslint-disable-next-line no-restricted-syntax
      for await (const msg of client.fetch(
        range,
        {
          uid: true,
          envelope: true,
          flags: true,
          bodyStructure: true,
          // Targeted field fetch for bulk-mail classification — cheap enough
          // to run over a whole page; see classifyBulk.
          headers: BULK_HEADER_FIELDS,
          ...(options.preview
            ? { bodyParts: [{ key: '1', start: 0, maxLength: PREVIEW_PART_BYTES }] }
            : {}),
        },
        { uid: true },
      )) {
        raw.push(msg as unknown as Record<string, unknown>);
      }

      if (options.preview) {
        await fetchNestedPreviews(client, raw);
      }

      raw.forEach((msg) => {
        items.push(messageToEmailMeta(msg));
      });

      items.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

      return {
        items,
        total,
        page,
        pageSize,
        hasMore: start + pageSize < total,
      };
    } finally {
      lock.release();
    }
  }

  // -------------------------------------------------------------------------
  // Labels
  // -------------------------------------------------------------------------

  async listLabels(accountName: string): Promise<LabelInfo[]> {
    const strategy = await this.getLabelStrategy(accountName);
    const client = await this.connections.getImapClient(accountName);
    return strategy.listLabels(client);
  }

  async addLabel(
    accountName: string,
    emailId: string,
    mailbox: string,
    label: string,
  ): Promise<void> {
    const strategy = await this.getLabelStrategy(accountName);
    const client = await this.connections.getImapClient(accountName);
    await strategy.addLabel(client, emailId, mailbox, label);
    // On a keyword-strategy server a label is a flag write: it moves neither
    // UIDNEXT nor MESSAGES, so the cache's STATUS probe cannot see it. Without
    // this event the next read serves the old label set, marked fresh.
    ImapService.emitChanged(accountName, sanitizeMailboxName(mailbox));
  }

  async removeLabel(
    accountName: string,
    emailId: string,
    mailbox: string,
    label: string,
  ): Promise<void> {
    const strategy = await this.getLabelStrategy(accountName);
    const client = await this.connections.getImapClient(accountName);
    await strategy.removeLabel(client, emailId, mailbox, label);
    ImapService.emitChanged(accountName, sanitizeMailboxName(mailbox));
  }

  async createLabel(accountName: string, name: string): Promise<void> {
    const strategy = await this.getLabelStrategy(accountName);
    const client = await this.connections.getImapClient(accountName);
    await strategy.createLabel(client, name);
  }

  async deleteLabel(accountName: string, name: string): Promise<void> {
    const strategy = await this.getLabelStrategy(accountName);
    const client = await this.connections.getImapClient(accountName);
    await strategy.deleteLabel(client, name);
  }

  // -------------------------------------------------------------------------
  // Virtual-folder detection
  // -------------------------------------------------------------------------

  private static readonly VIRTUAL_SPECIAL_USE = new Set(['\\All', '\\Flagged']);

  private static async assertRealMailbox(client: ImapFlow, mailboxPath: string): Promise<void> {
    const mailboxes = await client.list();
    const mb = mailboxes.find((m) => m.path === mailboxPath);
    if (!mb) return; // unknown — let the server reject if invalid
    const virtualFlag = [...ImapService.VIRTUAL_SPECIAL_USE].find(
      (f) => mb.specialUse === f || mb.flags?.has(f),
    );
    if (virtualFlag) {
      throw new Error(
        `"${mailboxPath}" is a virtual folder (${virtualFlag}). ` +
          'Use find_email_folder to locate the real folder first.',
      );
    }
  }

  // -------------------------------------------------------------------------
  // Find real folder for an email
  // -------------------------------------------------------------------------

  /** Folders a message is most likely to be in, in the order worth searching. */
  private static readonly LIKELY_SPECIAL_USE = ['\\Sent', '\\Drafts', '\\Archive'];

  /**
   * Order mailboxes so the first match is the one a caller would want to act
   * on, since the search stops there.
   */
  private static orderByLikelihood<T extends { path: string; specialUse?: string }>(
    mailboxes: T[],
  ): T[] {
    const rank = (mailbox: T): number => {
      if (mailbox.path === 'INBOX') return 0;
      const specialIndex = mailbox.specialUse
        ? ImapService.LIKELY_SPECIAL_USE.indexOf(mailbox.specialUse)
        : -1;
      return specialIndex === -1 ? ImapService.LIKELY_SPECIAL_USE.length + 1 : specialIndex + 1;
    };
    // Stable within a rank, so the server's own ordering is otherwise kept.
    return [...mailboxes].sort((a, b) => rank(a) - rank(b));
  }

  async findEmailFolder(
    accountName: string,
    emailId: string,
    sourceMailbox: string,
  ): Promise<{ folders: string[]; messageId?: string }> {
    const client = await this.connections.getImapClient(accountName);

    // 1. Fetch Message-ID from the source mailbox
    let messageId: string | undefined;
    const srcLock = await ImapService.lockMailbox(client, sourceMailbox);
    try {
      const msg = await client.fetchOne(emailId, { headers: true }, { uid: true });
      // biome-ignore lint/complexity/useOptionalChain: optional chain breaks TS type narrowing for union with false
      if (msg && msg.headers && Buffer.isBuffer(msg.headers)) {
        const headerText = msg.headers.toString('utf-8');
        const match = /^message-id:\s*(.+)$/im.exec(headerText);
        if (match?.[1]) {
          messageId = match[1].trim();
        }
      }
    } finally {
      srcLock.release();
    }

    if (!messageId) {
      throw new Error('Could not retrieve Message-ID for this email.');
    }

    // 2. List all real mailboxes (exclude virtual and non-selectable)
    const allMailboxes = await client.list();
    const realMailboxes = allMailboxes.filter((mb) => {
      if (!mb.listed) return false;
      if (mb.flags?.has('\\Noselect')) return false;
      const isVirtual = [...ImapService.VIRTUAL_SPECIAL_USE].some(
        (f) => mb.specialUse === f || mb.flags?.has(f),
      );
      if (isVirtual) return false;
      return true;
    });

    // 3. Search for the Message-ID, stopping at the first hit.
    //
    // Each folder costs a SELECT and a header SEARCH, and header SEARCH is
    // typically an unindexed server-side scan. Continuing after a match spent
    // that on every remaining folder to produce a list the caller was told to
    // take the first entry of.
    //
    // Likely folders go first so the one hit is also the useful one: a
    // message is far more often in INBOX or Sent than in an archive label.
    const searchOrder = ImapService.orderByLikelihood(realMailboxes);

    const folders: string[] = [];
    const findInMailbox = async (mbPath: string): Promise<boolean> => {
      try {
        const lock = await client.getMailboxLock(mbPath);
        try {
          const results = await client.search(
            { header: { 'message-id': messageId } },
            { uid: true },
          );
          return Array.isArray(results) && results.length > 0;
        } finally {
          lock.release();
        }
      } catch {
        // Skip folders that can't be selected or searched (e.g. \Noselect, INBOX on some providers)
        return false;
      }
    };
    // eslint-disable-next-line no-restricted-syntax
    for (const mb of searchOrder) {
      // eslint-disable-next-line no-await-in-loop
      if (await findInMailbox(mb.path)) {
        folders.push(mb.path);
        break;
      }
    }

    return { folders, messageId };
  }

  // -------------------------------------------------------------------------
  // Move / Delete
  // -------------------------------------------------------------------------

  async moveEmail(
    accountName: string,
    emailId: string,
    sourceMailbox: string,
    destinationMailbox: string,
  ): Promise<void> {
    const client = await this.connections.getImapClient(accountName);
    const safeSource = sanitizeMailboxName(sourceMailbox);
    const safeDest = sanitizeMailboxName(destinationMailbox);
    await ImapService.assertRealMailbox(client, safeSource);
    const lock = await client.getMailboxLock(safeSource);
    try {
      const ok = await imapCommand(`Moving message to "${safeDest}"`, () =>
        client.messageMove(emailId, safeDest, { uid: true }),
      );
      if (!ok) {
        throw new Error(`IMAP server rejected the move from "${safeSource}" to "${safeDest}".`);
      }
    } finally {
      lock.release();
    }
    ImapService.emitChanged(accountName, safeSource, safeDest);
  }

  async deleteEmail(
    accountName: string,
    emailId: string,
    mailbox = 'INBOX',
    permanent = false,
  ): Promise<void> {
    const client = await this.connections.getImapClient(accountName);
    const safeMailbox = sanitizeMailboxName(mailbox);

    if (permanent) {
      const lock = await client.getMailboxLock(safeMailbox);
      try {
        const ok = await client.messageDelete(emailId, { uid: true });
        if (!ok) {
          throw new Error('IMAP server rejected the delete operation.');
        }
      } finally {
        lock.release();
      }
      ImapService.emitChanged(accountName, safeMailbox);
    } else {
      await ImapService.assertRealMailbox(client, safeMailbox);
      const mailboxes = await client.list();
      const trash = mailboxes.find((mb) => mb.specialUse === '\\Trash');
      const trashPath = trash?.path ?? 'Trash';

      const lock = await client.getMailboxLock(safeMailbox);
      try {
        const ok = await imapCommand(`Moving message to "${trashPath}"`, () =>
          client.messageMove(emailId, trashPath, { uid: true }),
        );
        if (!ok) {
          throw new Error('IMAP server rejected the move to Trash.');
        }
      } finally {
        lock.release();
      }
      ImapService.emitChanged(accountName, safeMailbox, trashPath);
    }
  }

  // -------------------------------------------------------------------------
  // Flag management
  // -------------------------------------------------------------------------

  async setFlags(
    accountName: string,
    emailId: string,
    mailbox: string,
    action: 'read' | 'unread' | 'flag' | 'unflag',
  ): Promise<void> {
    const client = await this.connections.getImapClient(accountName);
    const safeMailbox = sanitizeMailboxName(mailbox);
    const lock = await client.getMailboxLock(safeMailbox);
    try {
      const flagMap: Record<typeof action, { flags: string[]; add: boolean }> = {
        read: { flags: ['\\Seen'], add: true },
        unread: { flags: ['\\Seen'], add: false },
        flag: { flags: ['\\Flagged'], add: true },
        unflag: { flags: ['\\Flagged'], add: false },
      };
      const { flags, add } = flagMap[action];
      let ok: boolean;
      if (add) {
        ok = await client.messageFlagsAdd(emailId, flags, { uid: true });
      } else {
        ok = await client.messageFlagsRemove(emailId, flags, { uid: true });
      }
      if (!ok) {
        throw new Error(`IMAP server rejected the ${action} flag operation.`);
      }
    } finally {
      lock.release();
    }
    ImapService.emitChanged(accountName, safeMailbox);
  }

  /**
   * Tell the local mirror a mailbox changed under this process's own hands.
   *
   * Emitted only after the server acknowledged the write, so the mirror never
   * resyncs toward a state that was rejected. Fires after the lock is
   * released: the sync engine's reaction needs that same mailbox lock.
   */
  private static emitChanged(account: string, ...mailboxes: string[]): void {
    for (const mailbox of new Set(mailboxes)) {
      eventBus.emit('email:changed', { account, mailbox });
    }
  }

  // -------------------------------------------------------------------------
  // Bulk operations
  // -------------------------------------------------------------------------

  async bulkSetFlags(
    accountName: string,
    ids: number[],
    mailbox: string,
    action: 'mark_read' | 'mark_unread' | 'flag' | 'unflag',
  ): Promise<BulkResult> {
    const client = await this.connections.getImapClient(accountName);
    const lock = await ImapService.lockMailbox(client, mailbox);
    const result: BulkResult = {
      total: ids.length,
      succeeded: 0,
      failed: 0,
      errors: [],
    };
    try {
      const flagMap: Record<typeof action, { flags: string[]; add: boolean }> = {
        mark_read: { flags: ['\\Seen'], add: true },
        mark_unread: { flags: ['\\Seen'], add: false },
        flag: { flags: ['\\Flagged'], add: true },
        unflag: { flags: ['\\Flagged'], add: false },
      };
      const { flags, add } = flagMap[action];
      const range = ids.join(',');
      let ok: boolean;
      if (add) {
        ok = await client.messageFlagsAdd(range, flags, { uid: true });
      } else {
        ok = await client.messageFlagsRemove(range, flags, { uid: true });
      }
      if (ok) {
        result.succeeded = ids.length;
      } else {
        result.failed = ids.length;
        result.errors = ['IMAP server rejected the flag operation.'];
      }
    } catch (err) {
      result.failed = ids.length;
      result.errors = [err instanceof Error ? err.message : String(err)];
    } finally {
      lock.release();
    }
    if (result.succeeded > 0) {
      ImapService.emitChanged(accountName, sanitizeMailboxName(mailbox));
    }
    if (result.errors?.length === 0) delete result.errors;
    return result;
  }

  async bulkMove(
    accountName: string,
    ids: number[],
    mailbox: string,
    destination: string,
  ): Promise<BulkResult> {
    const client = await this.connections.getImapClient(accountName);
    // The destination is never locked, so it needs validating on its own —
    // it goes straight to MOVE as a mailbox path.
    const safeDestination = sanitizeMailboxName(destination);
    await ImapService.assertRealMailbox(client, mailbox);
    const lock = await ImapService.lockMailbox(client, mailbox);
    const result: BulkResult = {
      total: ids.length,
      succeeded: 0,
      failed: 0,
      errors: [],
    };
    try {
      const range = ids.join(',');
      const ok = await imapCommand(`Moving messages to "${safeDestination}"`, () =>
        client.messageMove(range, safeDestination, { uid: true }),
      );
      if (ok) {
        result.succeeded = ids.length;
      } else {
        result.failed = ids.length;
        result.errors = ['IMAP server rejected the move operation.'];
      }
    } catch (err) {
      result.failed = ids.length;
      result.errors = [err instanceof Error ? err.message : String(err)];
    } finally {
      lock.release();
    }
    if (result.succeeded > 0) {
      ImapService.emitChanged(accountName, sanitizeMailboxName(mailbox), safeDestination);
    }
    if (result.errors?.length === 0) delete result.errors;
    return result;
  }

  async bulkDelete(
    accountName: string,
    ids: number[],
    mailbox: string,
    permanent = false,
  ): Promise<BulkResult> {
    const client = await this.connections.getImapClient(accountName);
    const result: BulkResult = {
      total: ids.length,
      succeeded: 0,
      failed: 0,
      errors: [],
    };

    if (permanent) {
      const lock = await ImapService.lockMailbox(client, mailbox);
      try {
        const range = ids.join(',');
        const ok = await client.messageDelete(range, { uid: true });
        if (ok) {
          result.succeeded = ids.length;
        } else {
          result.failed = ids.length;
          result.errors = ['IMAP server rejected the delete operation.'];
        }
      } catch (err) {
        result.failed = ids.length;
        result.errors = [err instanceof Error ? err.message : String(err)];
      } finally {
        lock.release();
      }
      if (result.succeeded > 0) {
        ImapService.emitChanged(accountName, sanitizeMailboxName(mailbox));
      }
    } else {
      await ImapService.assertRealMailbox(client, mailbox);
      const mailboxes = await client.list();
      const trash = mailboxes.find((mb) => mb.specialUse === '\\Trash');
      const trashPath = trash?.path ?? 'Trash';

      const lock = await ImapService.lockMailbox(client, mailbox);
      try {
        const range = ids.join(',');
        const ok = await imapCommand(`Moving messages to "${trashPath}"`, () =>
          client.messageMove(range, trashPath, { uid: true }),
        );
        if (ok) {
          result.succeeded = ids.length;
        } else {
          result.failed = ids.length;
          result.errors = ['IMAP server rejected the move to Trash.'];
        }
      } catch (err) {
        result.failed = ids.length;
        result.errors = [err instanceof Error ? err.message : String(err)];
      } finally {
        lock.release();
      }
      if (result.succeeded > 0) {
        ImapService.emitChanged(accountName, sanitizeMailboxName(mailbox), trashPath);
      }
    }

    if (result.errors?.length === 0) delete result.errors;
    return result;
  }

  // -------------------------------------------------------------------------
  // Draft management
  // -------------------------------------------------------------------------

  async saveDraft(
    accountName: string,
    options: {
      to: string[];
      subject: string;
      body: string;
      cc?: string[];
      bcc?: string[];
      html?: boolean;
      inReplyTo?: string;
      references?: string[];
    },
  ): Promise<{ id: number; mailbox: string }> {
    // Validate before touching the network: every one of these is spliced
    // into a hand-assembled header block.
    assertNoCrlf(options.subject, 'Subject');
    for (const addr of options.to) assertNoCrlf(addr, 'Recipient');
    for (const addr of options.cc ?? []) assertNoCrlf(addr, 'CC recipient');
    for (const addr of options.bcc ?? []) assertNoCrlf(addr, 'BCC recipient');
    if (options.inReplyTo) assertNoCrlf(options.inReplyTo, 'In-Reply-To');
    for (const ref of options.references ?? []) assertNoCrlf(ref, 'References entry');

    const client = await this.connections.getImapClient(accountName);
    const account = this.connections.getAccount(accountName);

    // Find the Drafts folder
    const mailboxes = await client.list();
    const drafts = mailboxes.find((mb) => mb.specialUse === '\\Drafts');
    const draftsPath = drafts?.path ?? 'Drafts';

    // Construct RFC 822 message. A header carries 7-bit ASCII only, so any
    // non-ASCII in the subject or display name becomes an RFC 2047 encoded
    // word; encodeWords leaves a pure-ASCII value untouched.
    const headers = [
      `From: ${formatFromHeader(account.fullName, account.email)}`,
      `To: ${options.to.join(', ')}`,
      `Subject: ${libmime.encodeWords(options.subject)}`,
      `Date: ${new Date().toUTCString()}`,
      `MIME-Version: 1.0`,
    ];

    if (options.cc?.length) headers.push(`Cc: ${options.cc.join(', ')}`);
    if (options.bcc?.length) headers.push(`Bcc: ${options.bcc.join(', ')}`);
    if (options.inReplyTo) headers.push(`In-Reply-To: ${options.inReplyTo}`);
    if (options.references?.length) {
      // One message-id per continuation line: valid RFC 5322 folding that can
      // never produce an overlong header line.
      headers.push(`References: ${options.references.join('\r\n ')}`);
    }

    let body: string;
    if (options.html) {
      // Mirrors what send_email puts on the wire: an HTML-only draft reads as
      // raw markup in any client that opens the Drafts folder, and sendDraft
      // would have to regenerate the alternative at send time anyway.
      const boundary = `----email-mcp-${randomUUID()}`;
      headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
      body = [
        `--${boundary}`,
        'Content-Type: text/plain; charset=utf-8',
        'Content-Transfer-Encoding: base64',
        '',
        base64Body(stripHtml(options.body)),
        `--${boundary}`,
        'Content-Type: text/html; charset=utf-8',
        'Content-Transfer-Encoding: base64',
        '',
        base64Body(options.body),
        `--${boundary}--`,
      ].join('\r\n');
    } else {
      headers.push('Content-Type: text/plain; charset=utf-8');
      headers.push('Content-Transfer-Encoding: base64');
      body = base64Body(options.body);
    }

    const rawMessage = `${headers.join('\r\n')}\r\n\r\n${body}`;

    const appendResult = await imapCommand(`Saving draft to "${draftsPath}"`, () =>
      client.append(draftsPath, Buffer.from(rawMessage), ['\\Draft', '\\Seen']),
    );

    return {
      id: (appendResult as unknown as { uid?: number }).uid ?? 0,
      mailbox: draftsPath,
    };
  }

  /**
   * Fetch a draft message for sending.
   * Returns the parsed draft with recipients and content.
   */
  async fetchDraft(
    accountName: string,
    emailId: number,
    mailbox?: string,
  ): Promise<{
    email: Email;
    mailbox: string;
  }> {
    const client = await this.connections.getImapClient(accountName);

    // Find drafts folder if not specified
    let draftsPath = mailbox;
    if (!draftsPath) {
      const mailboxes = await client.list();
      const draftsFolder = mailboxes.find((mb) => mb.specialUse === '\\Drafts');
      draftsPath = draftsFolder?.path ?? 'Drafts';
    }

    const email = await this.getEmail(accountName, String(emailId), draftsPath);
    return { email, mailbox: draftsPath };
  }

  /**
   * Resolve the folder `appendToSent` should file into.
   *
   * `sentMailbox` settles it outright for a mailbox that carries several
   * sent-shaped folders (a leftover `Sent` beside the server's actual
   * `\Sent`-flagged one). Otherwise prefer the folder the server
   * designates, then one plainly named "Sent", whatever its case.
   */
  private static async resolveSentFolder(
    client: ImapFlow,
    account: AccountConfig,
  ): Promise<string> {
    if (account.sentMailbox) return account.sentMailbox;

    const mailboxes = await client.list();
    const designated = mailboxes.find((mb) => mb.specialUse === '\\Sent');
    const byName = mailboxes.find((mb) => mb.path.toLowerCase() === 'sent');
    const sentPath = designated?.path ?? byName?.path;

    if (sentPath === undefined) {
      // Not every server ships one, and APPEND to a missing mailbox is
      // rejected — which the caller swallows so that a completed send is never
      // reported as failed, meaning the copy would disappear without a word.
      // Creating it is what a mail client does, and the user opted in.
      await imapCommand('Creating the "Sent" mailbox', () => client.mailboxCreate('Sent'));
    }
    return sentPath ?? 'Sent';
  }

  /**
   * Whether this account should APPEND its own copy of outgoing mail.
   *
   * Gmail files messages sent through its SMTP into Sent Mail itself, so an
   * APPEND on top of that leaves the user with every sent message twice.
   * Its IMAP server is identifiable by the X-GM-EXT-1 capability — a more
   * reliable signal than matching on the hostname, since it also covers
   * Google Workspace domains that don't look like gmail.com.
   *
   * `saveToSent` overrides the guess in either direction.
   */
  private static shouldFileSentCopy(account: AccountConfig, client: ImapFlow): boolean {
    if (account.saveToSent !== undefined) return account.saveToSent;
    // ImapFlow exposes capabilities as a Set on the client (see getCapabilities).
    const caps = (client as unknown as Record<string, unknown>).capabilities as
      | Set<string>
      | undefined;
    return !caps?.has('X-GM-EXT-1');
  }

  /**
   * APPEND an already-sent message to the account's Sent folder.
   *
   * SMTP delivers; it does not file a copy. Never throws: the message has
   * already been delivered, so a failed or skipped APPEND is reported back
   * instead — treating it as a send failure would be worse than the
   * original problem, and would invite a duplicate send.
   */
  async appendToSent(accountName: string, raw: Buffer): Promise<SentCopyResult> {
    const client = await this.connections.getImapClient(accountName);
    const account = this.connections.getAccount(accountName);

    if (!ImapService.shouldFileSentCopy(account, client)) {
      return { kind: 'skipped' };
    }

    try {
      const target = await ImapService.resolveSentFolder(client, account);
      // \Seen: the user wrote it, so it is not unread mail.
      await imapCommand(`Appending a sent copy to "${target}"`, () =>
        client.append(target, raw, ['\\Seen']),
      );
      return { kind: 'filed', path: target };
    } catch (err) {
      return { kind: 'failed', error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Delete a draft after it has been sent. */
  async deleteDraft(accountName: string, emailId: number, mailbox: string): Promise<void> {
    const client = await this.connections.getImapClient(accountName);
    const lock = await ImapService.lockMailbox(client, mailbox);
    try {
      await client.messageDelete(String(emailId), { uid: true });
    } finally {
      lock.release();
    }
  }

  // -------------------------------------------------------------------------
  // Mailbox (folder) CRUD
  // -------------------------------------------------------------------------

  async createMailbox(accountName: string, folderPath: string): Promise<void> {
    const client = await this.connections.getImapClient(accountName);
    await imapCommand(`Creating mailbox "${folderPath}"`, () => client.mailboxCreate(folderPath));
  }

  async renameMailbox(accountName: string, folderPath: string, newPath: string): Promise<void> {
    const client = await this.connections.getImapClient(accountName);
    await imapCommand(`Renaming mailbox "${folderPath}" to "${newPath}"`, () =>
      client.mailboxRename(folderPath, newPath),
    );
  }

  async deleteMailbox(accountName: string, folderPath: string): Promise<void> {
    const client = await this.connections.getImapClient(accountName);
    await imapCommand(`Deleting mailbox "${folderPath}"`, () => client.mailboxDelete(folderPath));
  }

  // -------------------------------------------------------------------------
  // Attachment download
  // -------------------------------------------------------------------------

  async downloadAttachment(
    accountName: string,
    emailId: string,
    mailbox: string,
    selector: string | { filename?: string; partId?: string },
    maxSizeBytes = 5 * 1024 * 1024,
  ): Promise<{
    filename: string;
    mimeType: string;
    size: number;
    contentBase64: string;
  }> {
    const result = await this.downloadAttachmentBuffer(
      accountName,
      emailId,
      mailbox,
      selector,
      maxSizeBytes,
    );
    return {
      filename: result.filename,
      mimeType: result.mimeType,
      size: result.size,
      contentBase64: result.content.toString('base64'),
    };
  }

  /**
   * Download an attachment and write it to the server-configured download
   * directory, instead of returning it base64-encoded. `config.dir` unset
   * means the operator has not opted in — refuse rather than guessing a
   * location. `saveAs`, when given, is a caller-supplied basename (validated
   * as a plain segment, never a path); otherwise the attachment's own
   * filename is sanitized the same way `save_attachments` already does.
   */
  async downloadAttachmentToDownloadDir(
    accountName: string,
    emailId: string,
    mailbox: string,
    selector: string | { filename?: string; partId?: string },
    config: AttachmentDownloadConfig,
    saveAs?: string,
  ): Promise<{ filename: string; mimeType: string; size: number; path: string }> {
    if (!config.dir) {
      throw new Error(
        'Attachment download directory is not configured (settings.attachment_download.dir)',
      );
    }
    const result = await this.downloadAttachmentBuffer(
      accountName,
      emailId,
      mailbox,
      selector,
      config.maxBytes,
    );
    const basename =
      saveAs !== undefined
        ? assertSafeDownloadBasename(saveAs)
        : sanitizeAttachmentBasename(result.filename);
    assertAllowedExtension(basename, config.allowedExtensions);
    const targetPath = await resolveAttachmentDownloadPath(config.dir, basename);
    await writeDownloadFileAtomic(targetPath, result.content);
    return {
      filename: result.filename,
      mimeType: result.mimeType,
      size: result.size,
      path: targetPath,
    };
  }

  /**
   * Download an attachment as a raw Buffer — shared by `downloadAttachment`
   * (base64-encodes it) and `downloadAttachmentToDownloadDir` (writes it to
   * disk), so the MIME-part lookup and decode-fallback logic lives once.
   */
  private async downloadAttachmentBuffer(
    accountName: string,
    emailId: string,
    mailbox: string,
    selector: string | { filename?: string; partId?: string },
    maxSizeBytes = 5 * 1024 * 1024,
  ): Promise<{
    filename: string;
    mimeType: string;
    size: number;
    content: Buffer;
  }> {
    const client = await this.connections.getImapClient(accountName);
    const uid = parseInt(emailId, 10);

    const lock = await ImapService.lockMailbox(client, mailbox);
    try {
      // Fetch bodyStructure to find the MIME part
      const msg = await client.fetchOne(
        String(uid),
        { uid: true, bodyStructure: true },
        { uid: true },
      );

      if (!msg) {
        throw new Error(`Email ${emailId} not found in ${mailbox}`);
      }

      const attachments = extractAttachments(msg.bodyStructure);
      const sel = typeof selector === 'string' ? { filename: selector } : selector;

      let attachment: AttachmentMeta | undefined;
      if (sel.partId !== undefined) {
        // The part id is unambiguous — duplicate filenames and unnamed parts
        // are only reachable this way.
        attachment = attachments.find((a) => a.partId === sel.partId);
        if (!attachment) {
          throw new Error(
            `No attachment with part id "${sel.partId}". Available: ${
              attachments.map((a) => `${a.partId} (${a.filename})`).join(', ') || 'none'
            }`,
          );
        }
      } else if (sel.filename !== undefined) {
        attachment = attachments.find((a) => a.filename === sel.filename);
        if (!attachment) {
          throw new Error(
            `Attachment "${sel.filename}" not found. Available: ${attachments.map((a) => a.filename).join(', ') || 'none'}`,
          );
        }
      } else {
        throw new Error('Either a filename or a partId is required');
      }

      // BODYSTRUCTURE reports encoded octets; base64 decodes ~25% smaller.
      // The cap means "bytes you will receive", so compare the estimate.
      const estimatedBytes =
        attachment.encoding === 'base64' ? Math.floor((attachment.size * 3) / 4) : attachment.size;
      if (estimatedBytes > maxSizeBytes) {
        throw new Error(
          `Attachment "${attachment.filename}" is ~${(estimatedBytes / 1024 / 1024).toFixed(1)}MB, exceeds ${Math.round(maxSizeBytes / 1024 / 1024)}MB limit`,
        );
      }

      // Find the MIME part number
      const partNumber =
        attachment.partId ?? findMimePartByFilename(msg.bodyStructure, attachment.filename);
      if (!partNumber) {
        throw new Error(`Could not locate MIME part for "${attachment.filename}"`);
      }

      // Download the part
      const downloadResult = await client.download(String(uid), partNumber, {
        uid: true,
      });

      if (!downloadResult?.content) {
        throw new Error(`Failed to download attachment "${attachment.filename}"`);
      }

      const downloadMeta = downloadResult.meta as Record<string, unknown> | undefined;
      const mayNeedBase64Decode =
        attachment.encoding === 'base64' && downloadMeta?.encoding === undefined;
      // Allow RFC 2045 base64 expansion (including line breaks) until we can
      // disambiguate raw base64 from an already-decoded BINARY response.
      const transferLimit = mayNeedBase64Decode
        ? (4 * Math.ceil(maxSizeBytes / 3) * 78) / 76 + 4
        : maxSizeBytes;
      const chunks: Buffer[] = [];
      let received = 0;
      let exceeded = false;
      // Drain an oversized part without retaining it. Aborting an ImapFlow
      // download mid-command can leave the shared connection desynchronized.
      for await (const chunk of downloadResult.content) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        received += buffer.length;
        if (received > transferLimit) {
          exceeded = true;
          chunks.length = 0;
        } else if (!exceeded) {
          chunks.push(buffer);
        }
      }
      if (exceeded)
        throw new Error(`Attachment "${attachment.filename}" exceeds ${maxSizeBytes} byte limit`);
      let content = Buffer.concat(chunks);

      // Some servers (GreenMail among them) answer the n.MIME section of a
      // nested part empty; ImapFlow then sees no transfer encoding and streams
      // the raw base64 through undecoded. Its meta.encoding mirrors what it
      // decoded with, so its absence next to a BODYSTRUCTURE-declared base64
      // means the decode never ran — apply it here.
      if (attachment.encoding === 'base64' && downloadMeta?.encoding === undefined) {
        // Only when the bytes really do look like base64 text. A server that
        // withholds the MIME section *and* serves the part via FETCH BINARY
        // hands back already-decoded data, and Buffer.from(…, 'base64') would
        // mangle it silently rather than throwing.
        const asText = content.toString('latin1');
        if (/^[A-Za-z0-9+/\s]*={0,2}\s*$/.test(asText)) {
          content = Buffer.from(asText, 'base64');
        }
      }

      if (content.length > maxSizeBytes) {
        throw new Error(`Attachment "${attachment.filename}" exceeds ${maxSizeBytes} byte limit`);
      }

      return {
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        size: content.length,
        content,
      };
    } finally {
      lock.release();
    }
  }

  // -------------------------------------------------------------------------
  // Save all email attachments to a local directory
  // -------------------------------------------------------------------------

  /**
   * Download and save all non-ICS attachments from an email to a local directory.
   * Returns metadata including the saved file paths and file:// URLs.
   *
   * Attachments larger than maxSizeBytes (default 25 MB) are skipped.
   */
  async saveEmailAttachments(
    accountName: string,
    emailId: string,
    mailbox: string,
    destDir: string,
    maxSizeBytes = 25 * 1024 * 1024,
  ): Promise<
    {
      filename: string;
      localPath: string;
      fileUrl: string;
      mimeType: string;
      size: number;
    }[]
  > {
    const client = await this.connections.getImapClient(accountName);
    const uid = parseInt(emailId, 10);

    const lock = await ImapService.lockMailbox(client, mailbox);
    let attachmentMetas: AttachmentMeta[] = [];
    try {
      const msg = await client.fetchOne(
        String(uid),
        { uid: true, bodyStructure: true },
        { uid: true },
      );
      if (!msg) return [];
      // Inline parts with no filename are layout machinery (spacers, tracking
      // pixels) and not worth a file on disk — but one that carries a filename
      // is a real file: Apple Mail ships user-inserted photos as
      // `inline; filename=...`, and dropping those loses the user's data.
      // biome-ignore format: line too long; eslint implicit-arrow-linebreak prevents multi-line implicit return
      attachmentMetas = extractAttachments(msg.bodyStructure).filter((a) => !(a.inline && a.filename === 'unnamed') && a.size <= maxSizeBytes && !a.mimeType.includes('calendar') && !a.filename.toLowerCase().endsWith('.ics'));
    } finally {
      lock.release();
    }

    if (attachmentMetas.length === 0) return [];

    const { mkdir } = await import('node:fs/promises');
    await mkdir(destDir, { recursive: true });

    const results = await Promise.allSettled(
      attachmentMetas.map(async (meta) => {
        const downloaded = await this.downloadAttachment(
          accountName,
          emailId,
          mailbox,
          // The part id survives duplicate filenames; filename is the fallback.
          meta.partId !== undefined ? { partId: meta.partId } : meta.filename,
          maxSizeBytes,
        );
        const safe = safeAttachmentFilename(meta.filename);
        const localPath = `${destDir}/${safe}`;
        const { writeFile } = await import('node:fs/promises');
        await writeFile(localPath, Buffer.from(downloaded.contentBase64, 'base64'));
        return {
          filename: meta.filename,
          localPath,
          fileUrl: `file://${localPath}`,
          mimeType: meta.mimeType,
          size: downloaded.size,
        };
      }),
    );

    type FulfilledValue = (typeof results)[0] extends PromiseFulfilledResult<infer T> ? T : never;
    return results
      .filter((r) => r.status === 'fulfilled')
      .map((r) => (r as PromiseFulfilledResult<FulfilledValue>).value);
  }

  /**
   * Reconstruct an email thread by following References / In-Reply-To chains.
   * Searches by Message-ID header for each reference and returns messages in
   * chronological order. Caps at MAX_THREAD_MESSAGES to prevent runaway chains.
   */
  async getThread(
    accountName: string,
    messageId: string,
    mailbox = 'INBOX',
  ): Promise<{
    threadId: string;
    messages: Email[];
    participants: EmailAddress[];
    messageCount: number;
  }> {
    const MAX_THREAD_MESSAGES = 50;
    const client = await this.connections.getImapClient(accountName);
    const lock = await ImapService.lockMailbox(client, mailbox);
    try {
      // Collect all Message-IDs in the thread
      const targetMsgIds = new Set<string>([messageId]);

      // First, find the root message to get its References chain
      const rootSearch = await client.search(
        { header: { 'Message-ID': messageId } },
        { uid: true },
      );
      const rootUids: number[] = Array.isArray(rootSearch) ? rootSearch : [];

      if (rootUids.length > 0) {
        const rootMsg = await client.fetchOne(
          String(rootUids[0]),
          { uid: true, envelope: true, source: true },
          { uid: true },
        );

        if (rootMsg) {
          const raw = rootMsg as unknown as Record<string, unknown>;
          const envelope = (raw.envelope ?? {}) as Record<string, unknown>;
          const inReplyTo = envelope.inReplyTo as string | undefined;
          if (inReplyTo) targetMsgIds.add(inReplyTo);

          // Parse References header from source
          if (raw.source && Buffer.isBuffer(raw.source)) {
            const src = raw.source.toString('utf-8');
            const refMatch = /^References:\s*(.+?)(?:\r?\n(?!\s))/ms.exec(src);
            if (refMatch?.[1]) {
              refMatch[1]
                .split(/\s+/)
                .filter(Boolean)
                .forEach((ref) => {
                  targetMsgIds.add(ref);
                });
            }
          }
        }
      }

      // Search for all related messages by Message-ID
      const foundUids = new Set<number>();
      // eslint-disable-next-line no-restricted-syntax
      for (const msgId of targetMsgIds) {
        if (foundUids.size >= MAX_THREAD_MESSAGES) break;

        try {
          // eslint-disable-next-line no-await-in-loop
          const searchResult = await client.search(
            { header: { 'Message-ID': msgId } },
            { uid: true },
          );
          if (Array.isArray(searchResult)) {
            searchResult.forEach((uid) => {
              foundUids.add(uid);
            });
          }
        } catch {
          // Header search may not be supported for all messages
        }
      }

      // Also search for messages that reference any of our Message-IDs
      // eslint-disable-next-line no-restricted-syntax
      for (const msgId of targetMsgIds) {
        if (foundUids.size >= MAX_THREAD_MESSAGES) break;

        try {
          // eslint-disable-next-line no-await-in-loop
          const refSearch = await client.search({ header: { References: msgId } }, { uid: true });
          if (Array.isArray(refSearch)) {
            refSearch.forEach((uid) => {
              foundUids.add(uid);
            });
          }
          // eslint-disable-next-line no-await-in-loop
          const replySearch = await client.search(
            { header: { 'In-Reply-To': msgId } },
            { uid: true },
          );
          if (Array.isArray(replySearch)) {
            replySearch.forEach((uid) => {
              foundUids.add(uid);
            });
          }
        } catch {
          // Header search may fail on some servers
        }
      }

      if (foundUids.size === 0) {
        return {
          threadId: messageId,
          messages: [],
          participants: [],
          messageCount: 0,
        };
      }

      // Fetch full content for all thread messages
      const uidList = Array.from(foundUids).slice(0, MAX_THREAD_MESSAGES);
      const range = uidList.join(',');
      const messages: Email[] = [];

      // Collect the whole fetch before converting any of it. messageToEmail
      // downloads a body part, and ImapFlow runs one command at a time — so
      // converting inside this loop deadlocks the connection: the stream can't
      // finish until the download does, and the download can't start until the
      // stream finishes.
      const rawMessages: Record<string, unknown>[] = [];
      // eslint-disable-next-line no-restricted-syntax
      for await (const msg of client.fetch(
        range,
        {
          uid: true,
          envelope: true,
          flags: true,
          bodyStructure: true,
          // Headers, not source: a thread caps at 50 messages, and pulling
          // full sources means transferring 50 entire messages — attachments
          // included — to render what is mostly a summary.
          headers: true,
        },
        { uid: true },
      )) {
        rawMessages.push(msg as unknown as Record<string, unknown>);
      }

      // eslint-disable-next-line no-restricted-syntax
      for (const raw of rawMessages) {
        // eslint-disable-next-line no-await-in-loop
        messages.push(await messageToEmail(raw, client, raw.uid as number));
      }

      // Sort chronologically
      messages.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

      // Extract unique participants
      const participantMap = new Map<string, EmailAddress>();
      messages.forEach((email) => {
        const addParticipant = (addr: EmailAddress) => {
          const key = addr.address.toLowerCase();
          if (!participantMap.has(key)) {
            participantMap.set(key, addr);
          }
        };
        addParticipant(email.from);
        email.to.forEach(addParticipant);
        email.cc?.forEach(addParticipant);
      });

      return {
        threadId: messageId,
        messages,
        participants: Array.from(participantMap.values()),
        messageCount: messages.length,
      };
    } finally {
      lock.release();
    }
  }

  // -------------------------------------------------------------------------
  // Contact extraction
  // -------------------------------------------------------------------------

  async extractContacts(
    accountName: string,
    options: { mailbox?: string; limit?: number } = {},
  ): Promise<Contact[]> {
    const client = await this.connections.getImapClient(accountName);
    const mailbox = options.mailbox ?? 'INBOX';
    const limit = Math.min(options.limit ?? 100, 500);

    const lock = await ImapService.lockMailbox(client, mailbox);
    try {
      // Search for all messages, take the latest N
      const searchResult = await client.search({ all: true }, { uid: true });
      const uids: number[] = Array.isArray(searchResult) ? searchResult : [];

      if (uids.length === 0) return [];

      uids.sort((a, b) => b - a);
      const targetUids = uids.slice(0, limit);
      const range = targetUids.join(',');

      const contactMap = new Map<
        string,
        { name?: string; email: string; frequency: number; lastSeen: Date }
      >();

      // eslint-disable-next-line no-restricted-syntax
      for await (const msg of client.fetch(range, { uid: true, envelope: true }, { uid: true })) {
        const envelope = ((msg as unknown as Record<string, unknown>).envelope ?? {}) as Record<
          string,
          unknown
        >;
        const date = envelope.date ? new Date(envelope.date as string) : new Date();

        const addressLists = [
          envelope.from as { name?: string; address?: string }[] | undefined,
          envelope.to as { name?: string; address?: string }[] | undefined,
          envelope.cc as { name?: string; address?: string }[] | undefined,
        ];

        addressLists.forEach((addrs) => {
          (addrs ?? []).forEach((addr) => {
            if (!addr.address) return;
            const key = addr.address.toLowerCase();
            const existing = contactMap.get(key);
            if (existing) {
              existing.frequency += 1;
              if (date > existing.lastSeen) {
                existing.lastSeen = date;
                if (addr.name) existing.name = addr.name;
              }
            } else {
              contactMap.set(key, {
                name: addr.name ?? undefined,
                email: addr.address,
                frequency: 1,
                lastSeen: date,
              });
            }
          });
        });
      }

      // Sort by frequency descending
      const contacts: Contact[] = Array.from(contactMap.values())
        .sort((a, b) => b.frequency - a.frequency)
        .map((c) => ({
          name: c.name,
          email: c.email,
          frequency: c.frequency,
          lastSeen: c.lastSeen.toISOString(),
        }));

      return contacts;
    } finally {
      lock.release();
    }
  }

  // -------------------------------------------------------------------------
  // Email analytics
  // -------------------------------------------------------------------------

  /**
   * Cheap counters for a dashboard-style snapshot: one STATUS round trip for
   * totals (no SELECT required) plus a UID-only SEARCH for today's count —
   * never a FETCH. Contrast `getEmailStats`, which FETCHes envelope, flags
   * and bodyStructure for every message in its window.
   */
  async getMailboxSnapshot(accountName: string, mailbox = 'INBOX'): Promise<MailboxSnapshot> {
    const client = await this.connections.getImapClient(accountName);
    const path = sanitizeMailboxName(mailbox);

    const status = (await client.status(path, {
      messages: true,
      unseen: true,
    })) as { messages?: number; unseen?: number };

    const since = new Date();
    since.setHours(0, 0, 0, 0);

    const lock = await ImapService.lockMailbox(client, path);
    try {
      const uids = await client.search({ since }, { uid: true });
      return {
        total: status.messages ?? 0,
        unread: status.unseen ?? 0,
        receivedToday: Array.isArray(uids) ? uids.length : 0,
      };
    } finally {
      lock.release();
    }
  }

  async getEmailStats(
    accountName: string,
    mailbox: string,
    period: 'day' | 'week' | 'month',
  ): Promise<EmailStats> {
    const client = await this.connections.getImapClient(accountName);

    const now = new Date();
    const since = new Date(now);
    if (period === 'day') since.setDate(since.getDate() - 1);
    else if (period === 'week') since.setDate(since.getDate() - 7);
    else since.setMonth(since.getMonth() - 1);

    const lock = await ImapService.lockMailbox(client, mailbox);
    try {
      // Date-range search
      const uids: number[] = await client
        .search({ since }, { uid: true })
        .then((r: unknown) => (Array.isArray(r) ? r : []) as number[]);

      if (uids.length === 0) {
        return {
          period,
          dateRange: {
            from: since.toISOString().slice(0, 10),
            to: now.toISOString().slice(0, 10),
          },
          totalReceived: 0,
          unreadCount: 0,
          flaggedCount: 0,
          topSenders: [],
          dailyVolume: [],
          hasAttachmentsCount: 0,
          avgPerDay: 0,
        };
      }

      const range = uids.join(',');
      const senderMap = new Map<string, { email: string; name?: string; count: number }>();
      const dailyMap = new Map<string, number>();
      let unread = 0;
      let flagged = 0;
      let withAttachments = 0;

      // eslint-disable-next-line no-restricted-syntax
      for await (const msg of client.fetch(
        range,
        {
          uid: true,
          envelope: true,
          flags: true,
          bodyStructure: true,
        },
        { uid: true },
      )) {
        const envelope = ((msg as unknown as Record<string, unknown>).envelope ?? {}) as Record<
          string,
          unknown
        >;
        const flags = ((msg as unknown as Record<string, unknown>).flags ??
          new Set()) as Set<string>;
        const { bodyStructure } = msg as unknown as Record<string, unknown>;

        // Count flags
        if (!flags.has('\\Seen')) unread += 1;
        if (flags.has('\\Flagged')) flagged += 1;
        if (hasAttachments(bodyStructure)) withAttachments += 1;

        // Track sender
        const fromList = (envelope.from ?? []) as {
          name?: string;
          address?: string;
        }[];
        const first = fromList[0];
        if (first?.address) {
          const key = first.address.toLowerCase();
          const existing = senderMap.get(key);
          if (existing) {
            existing.count += 1;
          } else {
            senderMap.set(key, {
              email: first.address,
              name: first.name,
              count: 1,
            });
          }
        }

        // Track daily volume
        const date = envelope.date ? new Date(envelope.date as string) : new Date();
        const dayKey = date.toISOString().slice(0, 10);
        dailyMap.set(dayKey, (dailyMap.get(dayKey) ?? 0) + 1);
      }

      const topSenders: SenderStat[] = Array.from(senderMap.values())
        .sort((a, b) => b.count - a.count)
        .slice(0, 10);

      const dailyVolume: DailyVolume[] = Array.from(dailyMap.entries())
        .map(([date, count]) => ({ date, count }))
        .sort((a, b) => a.date.localeCompare(b.date));

      const days = Math.max(1, dailyVolume.length);

      return {
        period,
        dateRange: {
          from: since.toISOString().slice(0, 10),
          to: now.toISOString().slice(0, 10),
        },
        totalReceived: uids.length,
        unreadCount: unread,
        flaggedCount: flagged,
        topSenders,
        dailyVolume,
        hasAttachmentsCount: withAttachments,
        avgPerDay: Math.round((uids.length / days) * 10) / 10,
      };
    } finally {
      lock.release();
    }
  }

  // -------------------------------------------------------------------------
  // Quota
  // -------------------------------------------------------------------------

  async getQuota(accountName: string): Promise<QuotaInfo | null> {
    const client = await this.connections.getImapClient(accountName);
    try {
      const quota = await (
        client as unknown as {
          getQuotaForMailbox: (path: string) => Promise<{
            storage?: { usage?: number; limit?: number };
          } | null>;
        }
      ).getQuotaForMailbox('INBOX');

      if (!quota?.storage?.limit) return null;

      const usedMb = Math.round((quota.storage.usage ?? 0) / 1024);
      const totalMb = Math.round(quota.storage.limit / 1024);
      return {
        usedMb,
        totalMb,
        percentage: totalMb > 0 ? Math.round((usedMb / totalMb) * 100) : 0,
      };
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Capabilities
  // -------------------------------------------------------------------------

  async getCapabilities(accountName: string): Promise<string[]> {
    const client = await this.connections.getImapClient(accountName);
    try {
      // ImapFlow exposes capabilities as a Set on the client
      const caps = (client as unknown as Record<string, unknown>).capabilities as
        | Set<string>
        | undefined;
      return caps ? Array.from(caps) : [];
    } catch {
      return [];
    }
  }

  // -------------------------------------------------------------------------
  // Calendar part extraction
  // -------------------------------------------------------------------------

  /* eslint-disable no-await-in-loop, no-restricted-syntax -- Sequential IMAP fetch required */
  async getCalendarParts(accountName: string, mailbox: string, emailId: string): Promise<string[]> {
    const client = await this.connections.getImapClient(accountName);
    const lock = await ImapService.lockMailbox(client, mailbox);

    try {
      const icsContents: string[] = [];

      // Drain the structure fetch completely before issuing any further
      // command. ImapFlow runs one command at a time, so starting the part
      // fetch inside this loop deadlocks: the outer stream cannot finish until
      // the inner one does, and the inner one cannot start until the outer
      // finishes.
      const partIds: string[] = [];
      for await (const msg of client.fetch(
        emailId,
        { uid: true, bodyStructure: true },
        { uid: true },
      )) {
        const structure = (msg as unknown as Record<string, unknown>).bodyStructure;
        partIds.push(...this.findCalendarParts(structure));
      }

      // Download each part, one command at a time.
      //
      // `download()` rather than `fetch({ bodyParts })`: calendar parts are
      // almost always base64 or quoted-printable, and a bodyParts fetch hands
      // back the still-encoded bytes. download() applies the transfer decoding,
      // so the ICS parser gets text it can actually read.
      for (const partId of partIds) {
        const part = await client.download(emailId, partId, { uid: true });
        if (!part?.content) continue;

        const chunks: Buffer[] = [];
        for await (const chunk of part.content) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        if (chunks.length > 0) {
          // ImapFlow transfer-decodes this part but does not charset-convert
          // it — its text handling covers only text/plain|html — so a Latin-1
          // ICS would come out as mojibake under a blind utf-8 read. The
          // declared charset rides along in the download meta.
          const raw = Buffer.concat(chunks);
          const charset =
            ((part.meta as Record<string, unknown> | undefined)?.charset as string | undefined) ??
            'utf-8';
          try {
            icsContents.push(new TextDecoder(charset).decode(raw));
          } catch {
            // Unknown charset label — utf-8 is the least-wrong fallback.
            icsContents.push(raw.toString('utf-8'));
          }
        }
      }

      return icsContents;
    } finally {
      lock.release();
    }
  }
  /* eslint-enable no-await-in-loop, no-restricted-syntax */

  /**
   * Recursively find body parts with text/calendar content type.
   */
  private findCalendarParts(structure: unknown, prefix = ''): string[] {
    if (!structure || typeof structure !== 'object') return [];
    const s = structure as Record<string, unknown>;
    const parts: string[] = [];

    const { type, subtype } = splitMimeType(s.type);
    const disposition = (s.disposition as string | undefined)?.toLowerCase() ?? '';

    // Check for text/calendar part
    if (type === 'text' && subtype === 'calendar') {
      const partId = s.part as string | undefined;
      if (partId) parts.push(partId);
      else if (prefix) parts.push(prefix);
    }

    // Check for .ics attachment
    if (disposition === 'attachment' && typeof s.dispositionParameters === 'object') {
      const params = s.dispositionParameters as Record<string, string>;
      const filename = params.filename ?? '';
      if (filename.toLowerCase().endsWith('.ics')) {
        const partId = s.part as string | undefined;
        if (partId) parts.push(partId);
        else if (prefix) parts.push(prefix);
      }
    }

    // Recurse into child nodes
    if (Array.isArray(s.childNodes)) {
      s.childNodes.forEach((child: unknown, i: number) => {
        const childPrefix = prefix ? `${prefix}.${i + 1}` : `${i + 1}`;
        parts.push(...this.findCalendarParts(child, childPrefix));
      });
    }

    return parts;
  }
}
