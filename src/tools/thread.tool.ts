/**
 * MCP tool: get_thread
 *
 * Reconstructs an email conversation thread using References / In-Reply-To
 * header chains. Returns messages in chronological order (or newest-first).
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type ImapService from '../services/imap.service.js';
import { formatBulk } from '../utils/bulk-headers.js';

// ---------------------------------------------------------------------------
// Inline body helpers (avoids cross-tool import)
// ---------------------------------------------------------------------------

function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function stripReplyChain(text: string): string {
  const lines = text.split('\n');
  const stopIdx = lines.findIndex((l) => /^--\s*$/.test(l) || /^_{3,}\s*$/.test(l));
  const relevant = stopIdx === -1 ? lines : lines.slice(0, stopIdx);
  return relevant
    .filter((l) => !l.startsWith('>'))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function applyBodyFormat(
  bodyText: string | undefined,
  bodyHtml: string | undefined,
  format: 'full' | 'text' | 'stripped',
  maxLength?: number,
): string {
  let body: string;
  if (format === 'full') {
    body = bodyText ?? bodyHtml ?? '(no content)';
  } else {
    const base = bodyText ?? (bodyHtml ? stripHtml(bodyHtml) : undefined) ?? '(no content)';
    body = format === 'stripped' ? stripReplyChain(base) : base;
  }
  if (maxLength !== undefined && maxLength > 0 && body.length > maxLength) {
    const remaining = body.length - maxLength;
    body = `${body.slice(0, maxLength)}\n\n… (${remaining} more characters — increase maxLength to read the full body)`;
  }
  return body;
}

// ---------------------------------------------------------------------------

export default function registerThreadTools(server: McpServer, imapService: ImapService): void {
  server.tool(
    'get_thread',
    'Reconstruct a full email conversation thread by following References and In-Reply-To headers. ' +
      'Returns all related messages. Does NOT mark emails as seen. ' +
      'Use format="text" to strip HTML, or format="stripped" to also remove quoted replies. ' +
      'Use newestFirst=true to show the most recent message in full and older messages as header-only summaries. ' +
      'Use get_email first to obtain the message_id. ' +
      'Each message carries a Bulk line when it is list or machine-generated mail.',
    {
      account: z.string().describe('Account name from list_accounts'),
      message_id: z.string().describe('Message-ID header value (from get_email)'),
      mailbox: z.string().default('INBOX').describe('Mailbox to search (default: INBOX)'),
      format: z
        .enum(['full', 'text', 'stripped'])
        .default('full')
        .describe(
          'Body format: full=raw (default), text=plain text (strips HTML), stripped=plain text without quoted replies or signatures',
        ),
      maxLength: z
        .number()
        .int()
        .min(100)
        .optional()
        .describe(
          'Truncate each message body at this many characters. A hint shows how many characters remain.',
        ),
      newestFirst: z
        .boolean()
        .default(false)
        .describe(
          'When true, shows the newest message in full and older messages as header-only summaries. ' +
            'Ideal for AI triage of long threads where only the latest reply matters.',
        ),
    },
    { readOnlyHint: true, destructiveHint: false },
    async ({ account, message_id: messageId, mailbox, format, maxLength, newestFirst }) => {
      try {
        const thread = await imapService.getThread(account, messageId, mailbox);

        if (thread.messageCount === 0) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `No thread found for Message-ID: ${messageId}`,
              },
            ],
          };
        }

        const ordered = newestFirst ? [...thread.messages].reverse() : thread.messages;
        const total = thread.messageCount;

        const parts: string[] = [
          `🧵 Thread: ${total} message${total === 1 ? '' : 's'}`,
          `Thread-ID: ${thread.threadId}`,
          `Participants: ${thread.participants.map((p) => (p.name ? `${p.name} <${p.address}>` : p.address)).join(', ')}`,
          '',
        ];

        ordered.forEach((email, idx) => {
          let label: string;
          if (newestFirst) {
            label = idx === 0 ? 'Latest message' : `Message ${total - idx} of ${total} (older)`;
          } else {
            label = `Message ${idx + 1} of ${total}`;
          }

          const from = email.from.name
            ? `${email.from.name} <${email.from.address}>`
            : email.from.address;

          parts.push(`--- ${label} ---`);
          parts.push(`From: ${from}`);
          parts.push(`To: ${email.to.map((a) => a.address).join(', ')}`);
          parts.push(`Date: ${email.date}`);
          parts.push(`Subject: ${email.subject}`);
          const bulkLine = formatBulk(email.bulk);
          if (bulkLine) {
            parts.push(`Bulk: ${bulkLine}`);
          }

          if (email.attachments.length > 0) {
            parts.push(`📎 ${email.attachments.map((a) => a.filename).join(', ')}`);
          }

          // In newestFirst mode, only render body for the newest (first) message
          if (newestFirst && idx > 0) {
            parts.push('(body omitted — use get_email to read this message)');
          } else {
            parts.push('');
            parts.push(applyBodyFormat(email.bodyText, email.bodyHtml, format, maxLength));
          }

          parts.push('');
        });

        return {
          content: [{ type: 'text' as const, text: parts.join('\n') }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Failed to get thread: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    },
  );
}
