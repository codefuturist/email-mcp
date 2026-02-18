/**
 * IMAP service — pure business logic for email read operations.
 *
 * No MCP dependency — fully unit-testable.
 */

import type { ImapFlow } from 'imapflow';
import type { IConnectionManager } from '../connections/types.js';
import { sanitizeMailboxName, sanitizeSearchQuery } from '../safety/validation.js';
import type {
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
  PaginatedResult,
  QuotaInfo,
  SenderStat,
} from '../types/index.js';
import type { LabelStrategy } from './label-strategy.js';
import { detectLabelStrategy } from './label-strategy.js';

// ---------------------------------------------------------------------------
// Helpers (must be defined before ImapService)
// ---------------------------------------------------------------------------

function parseAddress(addr: { name?: string; address?: string } | undefined): EmailAddress {
  return {
    name: addr?.name ?? undefined,
    address: addr?.address ?? 'unknown',
  };
}

function parseAddresses(addrs: { name?: string; address?: string }[] | undefined): EmailAddress[] {
  if (!addrs) return [];
  return addrs.map(parseAddress);
}

function hasAttachments(bodyStructure: unknown): boolean {
  if (!bodyStructure || typeof bodyStructure !== 'object') return false;
  const bs = bodyStructure as Record<string, unknown>;
  if (bs.disposition === 'attachment') return true;
  if (Array.isArray(bs.childNodes)) {
    return bs.childNodes.some((child: unknown) => hasAttachments(child));
  }
  return false;
}

function extractAttachments(bodyStructure: unknown): AttachmentMeta[] {
  const attachments: AttachmentMeta[] = [];
  if (!bodyStructure || typeof bodyStructure !== 'object') return attachments;

  const bs = bodyStructure as Record<string, unknown>;
  if (bs.disposition === 'attachment') {
    const params = (bs.dispositionParameters ?? bs.parameters ?? {}) as Record<string, string>;
    attachments.push({
      filename: params.filename ?? params.name ?? 'unnamed',
      mimeType: `${bs.type ?? 'application'}/${bs.subtype ?? 'octet-stream'}`,
      size: (bs.size as number) ?? 0,
    });
  }

  if (Array.isArray(bs.childNodes)) {
    (bs.childNodes as unknown[]).forEach((child) => {
      attachments.push(...extractAttachments(child));
    });
  }

  return attachments;
}

/** Find the MIME part number for an attachment by filename. */
function findMimePartByFilename(
  bodyStructure: unknown,
  targetFilename: string,
  partPath = '',
): string | undefined {
  if (!bodyStructure || typeof bodyStructure !== 'object') return undefined;

  const bs = bodyStructure as Record<string, unknown>;
  const currentPart = bs.part as string | undefined;
  const effectivePath = currentPart ?? partPath;

  if (bs.disposition === 'attachment') {
    const params = (bs.dispositionParameters ?? bs.parameters ?? {}) as Record<string, string>;
    const filename = params.filename ?? params.name ?? 'unnamed';
    if (filename === targetFilename) return effectivePath;
  }

  if (Array.isArray(bs.childNodes)) {
    // eslint-disable-next-line no-plusplus
    for (let i = 0; i < bs.childNodes.length; i++) {
      const childPart = effectivePath ? `${effectivePath}.${i + 1}` : String(i + 1);
      const found = findMimePartByFilename(bs.childNodes[i], targetFilename, childPart);
      if (found) return found;
    }
  }

  return undefined;
}

function messageToEmailMeta(msg: Record<string, unknown>): EmailMeta {
  const envelope = (msg.envelope ?? {}) as Record<string, unknown>;
  const flags = new Set((msg.flags ?? []) as string[]);

  // Extract non-system flags as labels (IMAP keywords)
  const labels = [...flags].filter((f) => !f.startsWith('\\'));

  // Extract preview from source buffer
  let preview: string | undefined;
  if (msg.source && Buffer.isBuffer(msg.source)) {
    const rawText = msg.source.toString('utf-8');
    // Try to extract body text after the header blank line
    const bodyStart = rawText.indexOf('\r\n\r\n');
    if (bodyStart >= 0) {
      preview = rawText
        .slice(bodyStart + 4, bodyStart + 204)
        .replace(/\s+/g, ' ')
        .trim();
    }
  }

  return {
    id: String(msg.uid ?? msg.seq),
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
    preview,
  };
}

async function messageToEmail(
  msg: Record<string, unknown>,
  client: ImapFlow,
  uid: number,
): Promise<Email> {
  const meta = messageToEmailMeta(msg);
  const envelope = (msg.envelope ?? {}) as Record<string, unknown>;

  // Parse full source for body content
  let bodyText: string | undefined;
  let bodyHtml: string | undefined;
  const headers: Record<string, string> = {};

  if (msg.source && Buffer.isBuffer(msg.source)) {
    const raw = msg.source.toString('utf-8');
    const headerEnd = raw.indexOf('\r\n\r\n');
    if (headerEnd >= 0) {
      // Parse headers
      const headerSection = raw.slice(0, headerEnd);
      headerSection.split('\r\n').forEach((line) => {
        const colonIdx = line.indexOf(':');
        if (colonIdx > 0 && !line.startsWith(' ') && !line.startsWith('\t')) {
          const key = line.slice(0, colonIdx).trim().toLowerCase();
          const value = line.slice(colonIdx + 1).trim();
          headers[key] = value;
        }
      });

      const body = raw.slice(headerEnd + 4);
      // Simple content type detection
      const contentType = headers['content-type'] ?? '';
      if (contentType.includes('text/html')) {
        bodyHtml = body;
      } else {
        bodyText = body;
      }
    }
  }

  // Try to get text/html parts via download if body parsing was simple
  try {
    const textPart = await client.download(String(uid), '1', { uid: true });
    if (textPart?.content) {
      const chunks: Buffer[] = [];
      // eslint-disable-next-line no-restricted-syntax
      for await (const chunk of textPart.content) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      bodyText = Buffer.concat(chunks).toString('utf-8');
    }
  } catch {
    // Part may not exist
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
  };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export default class ImapService {
  private labelStrategies = new Map<string, LabelStrategy>();

  constructor(private connections: IConnectionManager) {}

  private async getLabelStrategy(accountName: string): Promise<LabelStrategy> {
    const cached = this.labelStrategies.get(accountName);
    if (cached) return cached;

    const client = await this.connections.getImapClient(accountName);
    const strategy = await detectLabelStrategy(client);
    this.labelStrategies.set(accountName, strategy);
    return strategy;
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
        return {
          name: mb.name,
          path: mb.path,
          specialUse: mb.specialUse ?? undefined,
          totalMessages: status.messages ?? 0,
          unseenMessages: status.unseen ?? 0,
        };
      }),
    );

    return statusResults.map((result, idx) => {
      if (result.status === 'fulfilled') {
        return result.value;
      }
      // Fallback for folders that don't support STATUS (e.g. \Noselect)
      const mb = mailboxes[idx];
      return {
        name: mb.name,
        path: mb.path,
        specialUse: mb.specialUse ?? undefined,
        totalMessages: 0,
        unseenMessages: 0,
      };
    });
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
    } = {},
  ): Promise<PaginatedResult<EmailMeta>> {
    const client = await this.connections.getImapClient(accountName);
    const mailbox = sanitizeMailboxName(options.mailbox ?? 'INBOX');
    const page = options.page ?? 1;
    const pageSize = options.pageSize ?? 20;

    const lock = await client.getMailboxLock(mailbox);
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

      // Search for matching UIDs
      const searchResult = await client.search(search, { uid: true });
      let uids: number[] = Array.isArray(searchResult) ? searchResult : [];

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
          total: 0,
          page,
          pageSize,
          hasMore: false,
        };
      }

      // Sort descending (newest first) and paginate
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
      const range = pageUids.join(',');

      // eslint-disable-next-line no-restricted-syntax
      for await (const msg of client.fetch(
        range,
        {
          uid: true,
          envelope: true,
          flags: true,
          bodyStructure: true,
          source: { start: 0, maxLength: 256 },
        },
        { uid: true },
      )) {
        items.push(messageToEmailMeta(msg as unknown as Record<string, unknown>));
      }

      // Sort by date descending
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
          source: true,
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

    const lock = await client.getMailboxLock(mailbox);
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
      to?: string;
      hasAttachment?: boolean;
      largerThan?: number;
      smallerThan?: number;
      answered?: boolean;
    } = {},
  ): Promise<PaginatedResult<EmailMeta>> {
    const client = await this.connections.getImapClient(accountName);
    const mailbox = sanitizeMailboxName(options.mailbox ?? 'INBOX');
    const page = options.page ?? 1;
    const pageSize = options.pageSize ?? 20;
    const sanitizedQuery = query ? sanitizeSearchQuery(query) : '';

    const lock = await client.getMailboxLock(mailbox);
    try {
      // Build search criteria — base query OR across subject/from/body
      const baseCriteria: Record<string, unknown> = sanitizedQuery
        ? { or: [{ subject: sanitizedQuery }, { from: sanitizedQuery }, { body: sanitizedQuery }] }
        : {};

      // Build additional filters as AND conditions
      const andConditions: Record<string, unknown>[] = [baseCriteria];

      if (options.to) {
        andConditions.push({ to: options.to });
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
      const range = pageUids.join(',');

      // eslint-disable-next-line no-restricted-syntax
      for await (const msg of client.fetch(
        range,
        {
          uid: true,
          envelope: true,
          flags: true,
          bodyStructure: true,
          source: { start: 0, maxLength: 256 },
        },
        { uid: true },
      )) {
        items.push(messageToEmailMeta(msg as unknown as Record<string, unknown>));
      }

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

  async findEmailFolder(
    accountName: string,
    emailId: string,
    sourceMailbox: string,
  ): Promise<{ folders: string[]; messageId?: string }> {
    const client = await this.connections.getImapClient(accountName);

    // 1. Fetch Message-ID from the source mailbox
    let messageId: string | undefined;
    const srcLock = await client.getMailboxLock(sourceMailbox);
    try {
      const msg = await client.fetchOne(emailId, { headers: true }, { uid: true });
      if (msg && msg.headers && Buffer.isBuffer(msg.headers)) {
        const headerText = msg.headers.toString('utf-8');
        const match = /^message-id:\s*(.+)$/im.exec(headerText);
        if (match) {
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

    // 3. Search each real mailbox for the Message-ID (sequential — each needs its own lock)
    const folders: string[] = [];
    const searchMailbox = async (mbPath: string): Promise<void> => {
      try {
        const lock = await client.getMailboxLock(mbPath);
        try {
          const results = await client.search(
            { header: { 'message-id': messageId } },
            { uid: true },
          );
          if (results && Array.isArray(results) && results.length > 0) {
            folders.push(mbPath);
          }
        } finally {
          lock.release();
        }
      } catch {
        // Skip folders that can't be selected or searched (e.g. \Noselect, INBOX on some providers)
      }
    };
    // eslint-disable-next-line no-restricted-syntax
    for (const mb of realMailboxes) {
      // eslint-disable-next-line no-await-in-loop
      await searchMailbox(mb.path);
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
      const ok = await client.messageMove(emailId, safeDest, { uid: true });
      if (!ok) {
        throw new Error(`IMAP server rejected the move from "${safeSource}" to "${safeDest}".`);
      }
    } finally {
      lock.release();
    }
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
    } else {
      await ImapService.assertRealMailbox(client, safeMailbox);
      const mailboxes = await client.list();
      const trash = mailboxes.find((mb) => mb.specialUse === '\\Trash');
      const trashPath = trash?.path ?? 'Trash';

      const lock = await client.getMailboxLock(safeMailbox);
      try {
        const ok = await client.messageMove(emailId, trashPath, { uid: true });
        if (!ok) {
          throw new Error('IMAP server rejected the move to Trash.');
        }
      } finally {
        lock.release();
      }
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
      const flagMap: Record<string, { flags: string[]; add: boolean }> = {
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
    const lock = await client.getMailboxLock(mailbox);
    const result: BulkResult = {
      total: ids.length,
      succeeded: 0,
      failed: 0,
      errors: [],
    };
    try {
      const flagMap: Record<string, { flags: string[]; add: boolean }> = {
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
    await ImapService.assertRealMailbox(client, mailbox);
    const lock = await client.getMailboxLock(mailbox);
    const result: BulkResult = {
      total: ids.length,
      succeeded: 0,
      failed: 0,
      errors: [],
    };
    try {
      const range = ids.join(',');
      const ok = await client.messageMove(range, destination, { uid: true });
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
      const lock = await client.getMailboxLock(mailbox);
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
    } else {
      await ImapService.assertRealMailbox(client, mailbox);
      const mailboxes = await client.list();
      const trash = mailboxes.find((mb) => mb.specialUse === '\\Trash');
      const trashPath = trash?.path ?? 'Trash';

      const lock = await client.getMailboxLock(mailbox);
      try {
        const range = ids.join(',');
        const ok = await client.messageMove(range, trashPath, { uid: true });
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
    },
  ): Promise<{ id: number; mailbox: string }> {
    const client = await this.connections.getImapClient(accountName);
    const account = this.connections.getAccount(accountName);

    // Find the Drafts folder
    const mailboxes = await client.list();
    const drafts = mailboxes.find((mb) => mb.specialUse === '\\Drafts');
    const draftsPath = drafts?.path ?? 'Drafts';

    // Construct RFC 822 message
    const headers = [
      `From: ${account.fullName ? `"${account.fullName}" <${account.email}>` : account.email}`,
      `To: ${options.to.join(', ')}`,
      `Subject: ${options.subject}`,
      `Date: ${new Date().toUTCString()}`,
      `MIME-Version: 1.0`,
    ];

    if (options.cc?.length) headers.push(`Cc: ${options.cc.join(', ')}`);
    if (options.bcc?.length) headers.push(`Bcc: ${options.bcc.join(', ')}`);
    if (options.inReplyTo) headers.push(`In-Reply-To: ${options.inReplyTo}`);

    const contentType = options.html ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8';
    headers.push(`Content-Type: ${contentType}`);

    const rawMessage = `${headers.join('\r\n')}\r\n\r\n${options.body}`;

    const appendResult = await client.append(draftsPath, Buffer.from(rawMessage), [
      '\\Draft',
      '\\Seen',
    ]);

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

  /** Delete a draft after it has been sent. */
  async deleteDraft(accountName: string, emailId: number, mailbox: string): Promise<void> {
    const client = await this.connections.getImapClient(accountName);
    const lock = await client.getMailboxLock(mailbox);
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
    await client.mailboxCreate(folderPath);
  }

  async renameMailbox(accountName: string, folderPath: string, newPath: string): Promise<void> {
    const client = await this.connections.getImapClient(accountName);
    await client.mailboxRename(folderPath, newPath);
  }

  async deleteMailbox(accountName: string, folderPath: string): Promise<void> {
    const client = await this.connections.getImapClient(accountName);
    await client.mailboxDelete(folderPath);
  }

  // -------------------------------------------------------------------------
  // Attachment download
  // -------------------------------------------------------------------------

  async downloadAttachment(
    accountName: string,
    emailId: string,
    mailbox: string,
    filename: string,
    maxSizeBytes = 5 * 1024 * 1024,
  ): Promise<{
    filename: string;
    mimeType: string;
    size: number;
    contentBase64: string;
  }> {
    const client = await this.connections.getImapClient(accountName);
    const uid = parseInt(emailId, 10);

    const lock = await client.getMailboxLock(mailbox);
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
      const attachment = attachments.find((a) => a.filename === filename);
      if (!attachment) {
        throw new Error(
          `Attachment "${filename}" not found. Available: ${attachments.map((a) => a.filename).join(', ') || 'none'}`,
        );
      }

      if (attachment.size > maxSizeBytes) {
        throw new Error(
          `Attachment "${filename}" is ${Math.round(attachment.size / 1024 / 1024)}MB, exceeds ${Math.round(maxSizeBytes / 1024 / 1024)}MB limit`,
        );
      }

      // Find the MIME part number
      const partNumber = findMimePartByFilename(msg.bodyStructure, filename);
      if (!partNumber) {
        throw new Error(`Could not locate MIME part for "${filename}"`);
      }

      // Download the part
      const downloadResult = await client.download(String(uid), partNumber, {
        uid: true,
      });

      if (!downloadResult?.content) {
        throw new Error(`Failed to download attachment "${filename}"`);
      }

      const chunks: Buffer[] = [];
      // eslint-disable-next-line no-restricted-syntax
      for await (const chunk of downloadResult.content) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const content = Buffer.concat(chunks);

      return {
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        size: content.length,
        contentBase64: content.toString('base64'),
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

    const lock = await client.getMailboxLock(mailbox);
    let attachmentMetas: AttachmentMeta[] = [];
    try {
      const msg = await client.fetchOne(
        String(uid),
        { uid: true, bodyStructure: true },
        { uid: true },
      );
      if (!msg) return [];
      // biome-ignore format: line too long; eslint implicit-arrow-linebreak prevents multi-line implicit return
      attachmentMetas = extractAttachments(msg.bodyStructure).filter((a) => a.size <= maxSizeBytes && !a.mimeType.includes('calendar') && !a.filename.toLowerCase().endsWith('.ics'));
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
          meta.filename,
          maxSizeBytes,
        );
        const safe = meta.filename.replace(/[/\\?%*:|"<>]/g, '_');
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
    const lock = await client.getMailboxLock(mailbox);
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
            if (refMatch) {
              refMatch[1]
                .split(/\s+/)
                .filter(Boolean)
                .forEach((ref) => targetMsgIds.add(ref));
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
            searchResult.forEach((uid) => foundUids.add(uid));
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
            refSearch.forEach((uid) => foundUids.add(uid));
          }
          // eslint-disable-next-line no-await-in-loop
          const replySearch = await client.search(
            { header: { 'In-Reply-To': msgId } },
            { uid: true },
          );
          if (Array.isArray(replySearch)) {
            replySearch.forEach((uid) => foundUids.add(uid));
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

      // eslint-disable-next-line no-restricted-syntax
      for await (const msg of client.fetch(
        range,
        {
          uid: true,
          envelope: true,
          flags: true,
          bodyStructure: true,
          source: true,
        },
        { uid: true },
      )) {
        const raw = msg as unknown as Record<string, unknown>;
        const uid = raw.uid as number;
        messages.push(await messageToEmail(raw, client, uid));
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

    const lock = await client.getMailboxLock(mailbox);
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

    const lock = await client.getMailboxLock(mailbox);
    try {
      // Date-range search
      const uids: number[] = await client
        .search({ since }, { uid: true })
        .then((r: unknown) => (Array.isArray(r) ? r : []) as number[]);

      if (uids.length === 0) {
        return {
          period,
          dateRange: {
            from: since.toISOString().split('T')[0],
            to: now.toISOString().split('T')[0],
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
        if (fromList.length > 0 && fromList[0].address) {
          const key = fromList[0].address.toLowerCase();
          const existing = senderMap.get(key);
          if (existing) {
            existing.count += 1;
          } else {
            senderMap.set(key, {
              email: fromList[0].address,
              name: fromList[0].name,
              count: 1,
            });
          }
        }

        // Track daily volume
        const date = envelope.date ? new Date(envelope.date as string) : new Date();
        const dayKey = date.toISOString().split('T')[0];
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
          from: since.toISOString().split('T')[0],
          to: now.toISOString().split('T')[0],
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
    const lock = await client.getMailboxLock(mailbox);

    try {
      const icsContents: string[] = [];

      // Fetch body structure
      for await (const msg of client.fetch(
        emailId,
        { uid: true, bodyStructure: true },
        { uid: true },
      )) {
        const structure = (msg as unknown as Record<string, unknown>).bodyStructure;
        const parts = this.findCalendarParts(structure);

        // Fetch each calendar part
        for (const partId of parts) {
          for await (const partMsg of client.fetch(
            emailId,
            { uid: true, bodyParts: [partId] },
            { uid: true },
          )) {
            const bodyParts = (partMsg as unknown as Record<string, unknown>).bodyParts as
              | Map<string, Buffer>
              | undefined;
            if (bodyParts) {
              bodyParts.forEach((buf) => {
                icsContents.push(buf.toString('utf-8'));
              });
            }
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

    const type = (s.type as string | undefined)?.toLowerCase() ?? '';
    const subtype = (s.subtype as string | undefined)?.toLowerCase() ?? '';
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
