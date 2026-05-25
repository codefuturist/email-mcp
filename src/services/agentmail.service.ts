/**
 * AgentMail service — email operations via the AgentMail API.
 *
 * Provides an alternative to IMAP/SMTP for users who prefer a managed,
 * API-based email provider with simpler setup (API key only, no server
 * configuration required).
 *
 * No MCP dependency — fully unit-testable.
 */

import type {
  Email,
  EmailAddress,
  EmailMeta,
  Mailbox,
  PaginatedResult,
  SendResult,
} from '../types/index.js';

// ---------------------------------------------------------------------------
// AgentMail SDK types (minimal interface to avoid hard dependency)
// ---------------------------------------------------------------------------

/** Minimal shape of the AgentMail client we interact with. */
interface AgentMailInbox {
  inboxId: string;
  email: string;
  displayName?: string;
  createdAt?: string;
}

interface AgentMailMessage {
  messageId: string;
  from?: string;
  to?: string[];
  cc?: string[];
  subject?: string;
  text?: string;
  html?: string;
  extractedText?: string;
  createdAt?: string;
  attachments?: Array<{
    filename?: string;
    contentType?: string;
    size?: number;
  }>;
}

interface AgentMailMessageList {
  messages: AgentMailMessage[];
  nextCursor?: string;
}

interface AgentMailInboxList {
  inboxes: AgentMailInbox[];
  nextCursor?: string;
}

interface AgentMailSendOptions {
  to: string;
  subject: string;
  text?: string;
  html?: string;
}

interface AgentMailMessagesApi {
  list: (inboxId: string, options?: { limit?: number }) => Promise<AgentMailMessageList>;
  get: (inboxId: string, messageId: string) => Promise<AgentMailMessage>;
  send: (inboxId: string, options: AgentMailSendOptions) => Promise<AgentMailMessage>;
}

interface AgentMailInboxesApi {
  create: (options: { displayName?: string }) => Promise<AgentMailInbox>;
  list: (options?: { limit?: number }) => Promise<AgentMailInboxList>;
  get: (inboxId: string) => Promise<AgentMailInbox>;
  messages: AgentMailMessagesApi;
}

interface AgentMailClient {
  inboxes: AgentMailInboxesApi;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseEmailAddress(raw: string | undefined): EmailAddress {
  if (!raw) return { address: 'unknown' };
  const match = raw.match(/^(?:"?(.+?)"?\s)?<?([^\s>]+@[^\s>]+)>?$/);
  if (match) {
    return { name: match[1] || undefined, address: match[2] ?? raw };
  }
  return { address: raw };
}

function toEmailMeta(msg: AgentMailMessage, inboxId: string): EmailMeta {
  return {
    id: msg.messageId,
    subject: msg.subject ?? '(no subject)',
    from: parseEmailAddress(msg.from),
    to: (msg.to ?? []).map(parseEmailAddress),
    date: msg.createdAt ?? new Date().toISOString(),
    seen: true,
    flagged: false,
    answered: false,
    hasAttachments: (msg.attachments?.length ?? 0) > 0,
    labels: [],
    preview: (msg.extractedText ?? msg.text ?? '').slice(0, 120),
  };
}

function toEmail(msg: AgentMailMessage, inboxId: string): Email {
  return {
    ...toEmailMeta(msg, inboxId),
    cc: (msg.cc ?? []).map(parseEmailAddress),
    bodyText: msg.extractedText ?? msg.text,
    bodyHtml: msg.html,
    messageId: msg.messageId,
    attachments:
      msg.attachments?.map((a) => ({
        filename: a.filename ?? 'unnamed',
        mimeType: a.contentType ?? 'application/octet-stream',
        size: a.size ?? 0,
      })) ?? [],
    headers: {},
  };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export default class AgentMailService {
  private client: AgentMailClient;

  constructor(apiKey: string) {
    // Dynamically import the AgentMail SDK to avoid hard build-time dependency
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    this.client = this.createClient(apiKey);
  }

  private createClient(apiKey: string): AgentMailClient {
    // We construct a minimal client using fetch to avoid requiring the SDK
    // at build time. Users who install `agentmail` will get the real SDK.
    const baseUrl = 'https://api.agentmail.to/v0';
    const headers = {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    };

    const fetchJson = async (path: string, options?: RequestInit): Promise<unknown> => {
      const res = await fetch(`${baseUrl}${path}`, { ...options, headers });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`AgentMail API error (${res.status}): ${body}`);
      }
      return res.json();
    };

    return {
      inboxes: {
        create: async (opts) =>
          fetchJson('/inboxes', {
            method: 'POST',
            body: JSON.stringify({ display_name: opts.displayName }),
          }) as Promise<AgentMailInbox>,
        list: async (opts) =>
          fetchJson(`/inboxes?limit=${opts?.limit ?? 50}`) as Promise<AgentMailInboxList>,
        get: async (inboxId) => fetchJson(`/inboxes/${inboxId}`) as Promise<AgentMailInbox>,
        messages: {
          list: async (inboxId, opts) =>
            fetchJson(
              `/inboxes/${inboxId}/messages?limit=${opts?.limit ?? 50}`,
            ) as Promise<AgentMailMessageList>,
          get: async (inboxId, messageId) =>
            fetchJson(
              `/inboxes/${inboxId}/messages/${messageId}`,
            ) as Promise<AgentMailMessage>,
          send: async (inboxId, opts) =>
            fetchJson(`/inboxes/${inboxId}/messages`, {
              method: 'POST',
              body: JSON.stringify(opts),
            }) as Promise<AgentMailMessage>,
        },
      },
    };
  }

  // -------------------------------------------------------------------------
  // Inbox management
  // -------------------------------------------------------------------------

  async createInbox(displayName?: string): Promise<AgentMailInbox> {
    return this.client.inboxes.create({ displayName: displayName ?? 'Email MCP' });
  }

  async listInboxes(): Promise<Mailbox[]> {
    const result = await this.client.inboxes.list();
    return result.inboxes.map((inbox) => ({
      name: inbox.displayName ?? inbox.email,
      path: inbox.inboxId,
      totalMessages: 0,
      unseenMessages: 0,
    }));
  }

  async getInbox(inboxId: string): Promise<AgentMailInbox> {
    return this.client.inboxes.get(inboxId);
  }

  // -------------------------------------------------------------------------
  // Messages
  // -------------------------------------------------------------------------

  async listMessages(
    inboxId: string,
    options?: { page?: number; pageSize?: number },
  ): Promise<PaginatedResult<EmailMeta>> {
    const page = options?.page ?? 1;
    const pageSize = options?.pageSize ?? 20;

    const result = await this.client.inboxes.messages.list(inboxId, { limit: pageSize });
    const items = result.messages.map((m) => toEmailMeta(m, inboxId));

    return {
      items,
      total: items.length,
      page,
      pageSize,
      hasMore: result.nextCursor != null,
    };
  }

  async getMessage(inboxId: string, messageId: string): Promise<Email> {
    const msg = await this.client.inboxes.messages.get(inboxId, messageId);
    return toEmail(msg, inboxId);
  }

  async sendMessage(
    inboxId: string,
    options: {
      to: string[];
      subject: string;
      body: string;
      html?: boolean;
    },
  ): Promise<SendResult> {
    const msg = await this.client.inboxes.messages.send(inboxId, {
      to: options.to[0] ?? '',
      subject: options.subject,
      ...(options.html ? { html: options.body } : { text: options.body }),
    });

    return {
      messageId: msg.messageId ?? '',
      status: 'sent',
    };
  }
}
