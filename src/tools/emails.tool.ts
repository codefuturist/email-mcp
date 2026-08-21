/**
 * MCP tools: list_emails, get_email, get_emails, get_email_status, search_emails
 */

import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import type ImapService from '../services/imap.service.js';
import type { Email, EmailMeta } from '../types/index.js';
import { emailListOutputSchema, emailStatusOutputSchema } from './schemas.js';

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function formatEmailMeta(email: EmailMeta): string {
  const flags = [
    email.seen ? '' : '🔵',
    email.flagged ? '⭐' : '',
    email.answered ? '↩️' : '',
    email.hasAttachments ? '📎' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const from = email.from.name ? `${email.from.name} <${email.from.address}>` : email.from.address;
  const labelStr = email.labels.length > 0 ? `\n  🏷️ ${email.labels.join(', ')}` : '';

  return `[${email.id}] ${flags} ${email.subject}\n  From: ${from} | ${email.date}${labelStr}${email.preview ? `\n  ${email.preview}` : ''}`;
}

/** Strips HTML markup and decodes common entities to produce readable plain text. */
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

/** Removes quoted reply chains and signatures from plain text. */
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

type BodyFormat = 'full' | 'text' | 'stripped';

/**
 * Applies the requested body format and optional character cap.
 *
 * - full:     raw bodyText ?? bodyHtml (preserves original, default)
 * - text:     prefers bodyText; converts bodyHtml to plain text if needed
 * - stripped: like text, but also removes quoted reply chains and signatures
 */
function applyBodyFormat(
  bodyText: string | undefined,
  bodyHtml: string | undefined,
  format: BodyFormat,
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

/** Renders the current read/flag/label state as a concise status line. */
function formatEmailStatus(email: Pick<Email, 'seen' | 'flagged' | 'answered' | 'labels'>): string {
  const parts: string[] = [email.seen ? '✓ Read' : '🔵 Unread'];
  if (email.flagged) parts.push('⭐ Flagged');
  if (email.answered) parts.push('↩️ Replied');
  const labelStr = email.labels.length > 0 ? ` · 🏷️ ${email.labels.join(', ')}` : '';
  return `${parts.join(' · ')}${labelStr}`;
}

// ---------------------------------------------------------------------------

export default function registerEmailsTools(server: McpServer, imapService: ImapService): void {
  // ---------------------------------------------------------------------------
  // list_emails
  // ---------------------------------------------------------------------------
  server.registerTool(
    'list_emails',
    {
      title: 'List emails',
      description:
        'List emails in a mailbox with optional filters. Returns paginated results with metadata ' +
        '(read/unread 🔵, flagged ⭐, replied ↩️, attachments 📎, labels 🏷️). ' +
        'Use get_email to fetch full body content. ' +
        'ProtonMail note: labels are represented as IMAP folders — use list_labels to discover them, ' +
        'then list_emails with mailbox="Labels/X" to find labeled emails.',
      inputSchema: z.object({
        account: z.string().describe('Account name from list_accounts'),
        mailbox: z.string().default('INBOX').describe('Mailbox path (default: INBOX)'),
        page: z.number().int().min(1).default(1).describe('Page number'),
        pageSize: z.number().int().min(1).max(100).default(20).describe('Results per page'),
        since: z.string().optional().describe('Show emails after this date (ISO 8601)'),
        before: z.string().optional().describe('Show emails before this date (ISO 8601)'),
        from: z.string().optional().describe('Filter by sender address or name'),
        subject: z.string().optional().describe('Filter by subject keyword'),
        seen: z.boolean().optional().describe('Filter: true=read only, false=unread only'),
        flagged: z.boolean().optional().describe('Filter: true=flagged only, false=unflagged only'),
        has_attachment: z
          .boolean()
          .optional()
          .describe('Filter: true=has attachments, false=no attachments'),
        answered: z.boolean().optional().describe('Filter: true=replied, false=not yet replied'),
      }),
      outputSchema: emailListOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async (params) => {
      try {
        const result = await imapService.listEmails(params.account, {
          mailbox: params.mailbox,
          page: params.page,
          pageSize: params.pageSize,
          since: params.since,
          before: params.before,
          from: params.from,
          subject: params.subject,
          seen: params.seen,
          flagged: params.flagged,
          hasAttachment: params.has_attachment,
          answered: params.answered,
        });

        if (result.items.length === 0) {
          return {
            content: [{ type: 'text' as const, text: 'No emails found matching the criteria.' }],
            structuredContent: {
              account: params.account,
              mailbox: params.mailbox,
              total: 0,
              page: params.page,
              pageSize: params.pageSize,
              hasMore: false,
              count: 0,
              emails: [],
            },
          };
        }

        const header =
          `📬 [${params.mailbox}] ${result.total} emails ` +
          `(page ${result.page}/${Math.ceil(result.total / result.pageSize)})` +
          `${result.hasMore ? ' — more pages available' : ''}\n`;
        const emails = result.items.map(formatEmailMeta).join('\n\n');

        return {
          content: [{ type: 'text' as const, text: `${header}\n${emails}` }],
          structuredContent: {
            account: params.account,
            mailbox: params.mailbox,
            total: result.total,
            page: result.page,
            pageSize: result.pageSize,
            hasMore: result.hasMore,
            count: result.items.length,
            emails: result.items,
          },
        };
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Failed to list emails: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    },
  );

  // ---------------------------------------------------------------------------
  // get_email
  // ---------------------------------------------------------------------------
  server.registerTool(
    'get_email',
    {
      title: 'Get email',
      description:
        'Get the full content of a specific email by ID. ' +
        'Does NOT mark the email as seen (uses IMAP BODY.PEEK — non-destructive). ' +
        'Use format="text" to strip HTML, or format="stripped" to also remove quoted replies and signatures. ' +
        'Use maxLength to cap the body size for large emails. ' +
        'Set markRead=true only when you want to explicitly mark the email as read.',
      inputSchema: z.object({
        account: z.string().describe('Account name from list_accounts'),
        emailId: z.string().describe('Email ID from list_emails or search_emails'),
        mailbox: z.string().default('INBOX').describe('Mailbox path (default: INBOX)'),
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
            'Truncate body at this many characters. A hint shows how many characters remain.',
          ),
        markRead: z
          .boolean()
          .default(false)
          .describe(
            'Explicitly mark the email as read after fetching (default: false — reading is non-destructive by default)',
          ),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ account, emailId, mailbox, format, maxLength, markRead }) => {
      try {
        const email = await imapService.getEmail(account, emailId, mailbox);

        const parts: string[] = [
          `📧 ${email.subject}`,
          `Status: ${formatEmailStatus(email)}`,
          `From:   ${email.from.name ? `${email.from.name} <${email.from.address}>` : email.from.address}`,
          `To:     ${email.to.map((a) => (a.name ? `${a.name} <${a.address}>` : a.address)).join(', ')}`,
        ];

        if (email.cc?.length) {
          parts.push(`CC:     ${email.cc.map((a) => a.address).join(', ')}`);
        }

        parts.push(`Date:   ${email.date}`);
        parts.push(`ID:     ${email.messageId}`);

        if (email.inReplyTo) {
          parts.push(`Reply:  ${email.inReplyTo}`);
        }

        if (email.attachments.length > 0) {
          parts.push(
            `📎 Attachments: ${email.attachments.map((a) => `${a.filename} (${a.mimeType}, ${formatSize(a.size)})`).join(', ')}`,
          );
        }

        parts.push('', '--- Body ---', '');
        parts.push(
          applyBodyFormat(email.bodyText, email.bodyHtml, format as BodyFormat, maxLength),
        );

        if (markRead) {
          await imapService.setFlags(account, emailId, mailbox, 'read');
        }

        return {
          content: [{ type: 'text' as const, text: parts.join('\n') }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Failed to get email: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    },
  );

  // ---------------------------------------------------------------------------
  // get_emails  (batch content fetch)
  // ---------------------------------------------------------------------------
  server.registerTool(
    'get_emails',
    {
      title: 'Get multiple emails',
      description:
        'Fetch the full content of multiple emails in a single call (max 20). ' +
        'More efficient than calling get_email repeatedly when triaging or summarising several emails. ' +
        'Does NOT mark emails as seen. ' +
        'Defaults to format="text" (HTML stripped) for compact, AI-friendly output.',
      inputSchema: z.object({
        account: z.string().describe('Account name from list_accounts'),
        ids: z
          .array(z.string())
          .min(1)
          .max(20)
          .describe('Email IDs to fetch (max 20). Obtain IDs from list_emails or search_emails.'),
        mailbox: z.string().default('INBOX').describe('Mailbox path (default: INBOX)'),
        format: z
          .enum(['full', 'text', 'stripped'])
          .default('text')
          .describe(
            'Body format (default: text — strips HTML for efficient AI reading). Use stripped to also remove quoted replies.',
          ),
        maxLength: z
          .number()
          .int()
          .min(100)
          .optional()
          .describe('Truncate each email body at this many characters.'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ account, ids, mailbox, format, maxLength }) => {
      const results: string[] = [];
      const errors: string[] = [];

      const settled = await Promise.allSettled(
        ids.map(async (emailId) => imapService.getEmail(account, emailId, mailbox)),
      );

      settled.forEach((outcome, i) => {
        const emailId = ids[i];
        if (outcome.status === 'fulfilled') {
          const email = outcome.value;
          const from = email.from.name
            ? `${email.from.name} <${email.from.address}>`
            : email.from.address;
          const body = applyBodyFormat(
            email.bodyText,
            email.bodyHtml,
            format as BodyFormat,
            maxLength,
          );
          const attachLine =
            email.attachments.length > 0
              ? `📎 ${email.attachments.map((a) => a.filename).join(', ')}`
              : '';

          results.push(
            [
              `━━━ [${emailId}] ${email.subject}`,
              `Status: ${formatEmailStatus(email)}`,
              `From:   ${from}`,
              `Date:   ${email.date}`,
              attachLine,
              '',
              body,
            ]
              .filter((l) => l !== '')
              .join('\n'),
          );
        } else {
          const err = outcome.reason as unknown;
          errors.push(`[${emailId}] Error: ${err instanceof Error ? err.message : String(err)}`);
        }
      });

      const errSuffix = errors.length > 0 ? `, ${errors.length} error(s)` : '';
      const summary = `📬 [${mailbox}] ${results.length} email(s) fetched${errSuffix}`;

      const parts: string[] = [summary, '', ...results];
      if (errors.length > 0) {
        parts.push('', '--- Errors ---', ...errors);
      }

      return {
        content: [{ type: 'text' as const, text: parts.join('\n') }],
      };
    },
  );

  // ---------------------------------------------------------------------------
  // get_email_status  (lightweight flag/label check — no body fetch)
  // ---------------------------------------------------------------------------
  server.registerTool(
    'get_email_status',
    {
      title: 'Get email status',
      description:
        'Get the current read/flag/label state of an email without fetching its body. ' +
        'Much cheaper than get_email when you only need to check whether an email is unread, ' +
        'flagged, or which labels it has. ' +
        'Also useful to confirm the result of a mark_email call. ' +
        'Does NOT mark the email as seen.',
      inputSchema: z.object({
        account: z.string().describe('Account name from list_accounts'),
        emailId: z.string().describe('Email ID from list_emails or search_emails'),
        mailbox: z.string().default('INBOX').describe('Mailbox path (default: INBOX)'),
      }),
      outputSchema: emailStatusOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ account, emailId, mailbox }) => {
      try {
        const flags = await imapService.getEmailFlags(account, emailId, mailbox);

        const statusParts: string[] = [flags.seen ? '✓ Read' : '🔵 Unread'];
        if (flags.flagged) statusParts.push('⭐ Flagged');
        if (flags.answered) statusParts.push('↩️ Replied');

        const lines = [
          `📊 Email Status`,
          `ID:      ${emailId} | Mailbox: ${mailbox}`,
          `Subject: ${flags.subject}`,
          `From:    ${flags.from}`,
          `Date:    ${flags.date}`,
          `Status:  ${statusParts.join(' · ')}`,
          `Labels:  ${flags.labels.length > 0 ? flags.labels.join(', ') : '(none)'}`,
        ];

        return {
          content: [{ type: 'text' as const, text: lines.join('\n') }],
          structuredContent: {
            id: emailId,
            mailbox,
            subject: flags.subject,
            from: flags.from,
            date: flags.date,
            seen: flags.seen,
            flagged: flags.flagged,
            answered: flags.answered,
            labels: flags.labels,
          },
        };
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Failed to get email status: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    },
  );

  // ---------------------------------------------------------------------------
  // search_emails
  // ---------------------------------------------------------------------------
  server.registerTool(
    'search_emails',
    {
      title: 'Search emails',
      description:
        'Search emails by keyword across subject, sender, and body. ' +
        'Omit query (or pass an empty string) to use it as a pure filter — e.g. find all emails ' +
        'with attachments from a specific recipient without a keyword. ' +
        'Supports additional filters for recipient, attachments, size, and reply status.',
      inputSchema: z.object({
        account: z.string().describe('Account name from list_accounts'),
        query: z
          .string()
          .optional()
          .default('')
          .describe('Search keyword (omit or leave empty to use filters only)'),
        mailbox: z.string().default('INBOX').describe('Mailbox path (default: INBOX)'),
        page: z.number().int().min(1).default(1).describe('Page number'),
        pageSize: z.number().int().min(1).max(100).default(20).describe('Results per page'),
        to: z.string().optional().describe('Filter by recipient address'),
        has_attachment: z
          .boolean()
          .optional()
          .describe('Filter: true=has attachments, false=no attachments'),
        larger_than: z.number().optional().describe('Minimum email size in KB'),
        smaller_than: z.number().optional().describe('Maximum email size in KB'),
        answered: z.boolean().optional().describe('Filter: true=replied, false=not replied'),
      }),
      outputSchema: emailListOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async (params) => {
      try {
        const result = await imapService.searchEmails(params.account, params.query ?? '', {
          mailbox: params.mailbox,
          page: params.page,
          pageSize: params.pageSize,
          to: params.to,
          hasAttachment: params.has_attachment,
          largerThan: params.larger_than,
          smallerThan: params.smaller_than,
          answered: params.answered,
        });

        if (result.items.length === 0) {
          return {
            content: [
              {
                type: 'text' as const,
                text: params.query
                  ? `No emails found matching "${params.query}".`
                  : 'No emails found matching the specified filters.',
              },
            ],
            structuredContent: {
              account: params.account,
              mailbox: params.mailbox,
              total: 0,
              page: params.page,
              pageSize: params.pageSize,
              hasMore: false,
              count: 0,
              emails: [],
            },
          };
        }

        const queryLabel = params.query ? `"${params.query}"` : 'filters';
        const header =
          `🔍 [${params.mailbox}] ${result.total} result(s) for ${queryLabel} ` +
          `(page ${result.page}/${Math.ceil(result.total / result.pageSize)})\n`;
        const emails = result.items.map(formatEmailMeta).join('\n\n');

        return {
          content: [{ type: 'text' as const, text: `${header}\n${emails}` }],
          structuredContent: {
            account: params.account,
            mailbox: params.mailbox,
            total: result.total,
            page: result.page,
            pageSize: result.pageSize,
            hasMore: result.hasMore,
            count: result.items.length,
            emails: result.items,
          },
        };
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Failed to search emails: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    },
  );
}
