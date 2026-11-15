/**
 * MCP tools: send_email, reply_email, forward_email
 */

import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import audit from '../safety/audit.js';
import { validateInputLength } from '../safety/validation.js';

import { formatSize, prepareAttachments } from '../services/attachments.js';
import type SmtpService from '../services/smtp.service.js';
import type { SentCopyResult } from '../types/index.js';

/**
 * A bare path, or a path with inline/cid metadata. The object form exists for
 * HTML mail embedding images: give the file a cid and reference it in the
 * body as <img src="cid:...">.
 */
export const attachmentInputSchema = z.union([
  z.string(),
  z
    .object({
      path: z.string().describe('Local file path'),
      filename: z
        .string()
        .optional()
        .describe('Filename shown to the recipient (default: the file basename)'),
      cid: z
        .string()
        .optional()
        .describe(
          'Content-ID for inline embedding — reference as <img src="cid:...."> in an HTML body',
        ),
      contentType: z
        .string()
        .optional()
        .describe('Explicit MIME type when the file extension would misdetect'),
    })
    // Strict so a near-miss key fails loudly. Writing `contentId` for `cid`
    // would otherwise be dropped silently and the send would "succeed" with
    // an image that never embeds.
    .strict(),
]);

/** One result line per attachment, so the caller sees exactly what went out. */
function attachmentReport(prepared: Awaited<ReturnType<typeof prepareAttachments>> | null): string {
  if (!prepared || prepared.attachments.length === 0) return '';
  const lines = prepared.attachments.map((a) => `  - ${a.filename} (${formatSize(a.size)})`);
  return `\n📎 Attachments (${prepared.attachments.length}, ${formatSize(prepared.totalBytes)} raw ≈ ${formatSize(prepared.totalEncodedBytes)} encoded):\n${lines.join('\n')}`;
}

/**
 * Mention filing a Sent-folder copy only when it is worth mentioning: a
 * confirmation that it worked, or a warning that it didn't. A plain skip —
 * the setting is off for almost every account — is the default and silent
 * case, so staying quiet about it keeps the common reply uncluttered.
 */
function sentCopyNote(sentCopy: SentCopyResult | undefined): string {
  if (sentCopy?.kind === 'filed') return `\n📁 Filed a copy in "${sentCopy.path}"`;
  if (sentCopy?.kind === 'failed') return `\n⚠️ Could not file a copy in Sent: ${sentCopy.error}`;
  return '';
}

/**
 * Optional sender identity. Shared by the send tools so the wording — and the
 * rule that only configured identities pass — stays the same everywhere.
 */
export const fromInputSchema = z
  .string()
  .email()
  .optional()
  .describe(
    "Send as this address: the account's own email or one of its configured identities " +
      '(list_accounts shows them). Any other address is rejected. Default: the account email.',
  );

/** Attachment caps the send tools enforce (resolved per account at call time). */
export interface SendLimit {
  /** Global `[settings.send]` cap, used in tool descriptions. */
  globalMb: number;
  /** Effective cap for one account (per-account override / provider limit / global). */
  forAccount: (account: string) => number;
}

export default function registerSendTools(
  server: McpServer,
  smtpService: SmtpService,
  sendLimit: SendLimit,
): void {
  // ---------------------------------------------------------------------------
  // send_email
  // ---------------------------------------------------------------------------
  server.registerTool(
    'send_email',
    {
      title: 'Send email',
      description:
        'Send a new email. Supports plain text or HTML body, CC, and BCC, and sending as a configured alias (from).',
      inputSchema: z.object({
        account: z.string().describe('Account name from list_accounts'),
        from: fromInputSchema,
        to: z.array(z.string().email()).min(1).describe('Recipient email addresses'),
        subject: z.string().describe('Email subject'),
        body: z.string().describe('Email body content'),
        cc: z.array(z.string().email()).optional().describe('CC recipients'),
        bcc: z.array(z.string().email()).optional().describe('BCC recipients'),
        html: z.boolean().default(false).describe('Send as HTML (default: plain text)'),
        attachments: z
          .array(attachmentInputSchema)
          .optional()
          .describe(
            `Files to attach: plain paths, or {path, cid, contentType, filename} objects for inline images. Sizes are checked before sending; the base64-encoded total must stay under the account's effective limit (global cap ${sendLimit.globalMb} MB; known provider or per-account limits may be stricter).`,
          ),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (params) => {
      try {
        validateInputLength(params.subject, 998, 'Subject');
        validateInputLength(params.body, 5_000_000, 'Body');
        const prepared = params.attachments?.length
          ? await prepareAttachments(params.attachments, sendLimit.forAccount(params.account))
          : null;
        const result = await smtpService.sendEmail(params.account, {
          ...params,
          attachments: prepared?.attachments,
        });
        await audit.log(
          'send_email',
          params.account,
          { to: params.to, subject: params.subject, from: result.from },
          'ok',
        );
        return {
          content: [
            {
              type: 'text' as const,
              text: `✅ Email sent successfully!\nFrom: ${result.from}\nTo: ${params.to.join(', ')}\nSubject: ${params.subject}\nMessage-ID: ${result.messageId}${attachmentReport(prepared)}${sentCopyNote(result.sentCopy)}`,
            },
          ],
        };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        await audit.log(
          'send_email',
          params.account,
          { to: params.to, subject: params.subject },
          'error',
          errMsg,
        );
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Failed to send email: ${errMsg}`,
            },
          ],
        };
      }
    },
  );

  // ---------------------------------------------------------------------------
  // reply_email
  // ---------------------------------------------------------------------------
  server.registerTool(
    'reply_email',
    {
      title: 'Reply email',
      description:
        'Reply to an email with proper threading (In-Reply-To & References headers). Use get_email first to read the original. ' +
        'The original message is quoted below the reply by default (Thunderbird/Outlook style) — set quoteOriginal=false for the bare body only. ' +
        'Sends from the identity the original was addressed to unless from is given.',
      inputSchema: z.object({
        account: z.string().describe('Account name from list_accounts'),
        from: z
          .string()
          .email()
          .optional()
          .describe(
            "Send as this address: the account's own email or one of its configured identities. " +
              'Default: the identity the original was addressed to (To, Cc, then delivery headers), else the account email.',
          ),
        emailId: z.string().describe('Email ID to reply to (from list_emails or get_email)'),
        mailbox: z.string().default('INBOX').describe('Mailbox where the original email is'),
        body: z.string().describe('Reply body content'),
        replyAll: z.boolean().default(false).describe('Reply to all recipients'),
        html: z.boolean().default(false).describe('Send as HTML'),
        quoteOriginal: z
          .boolean()
          .default(true)
          .describe(
            'Append the original message as a quoted block below the reply ' +
              '(Thunderbird/Outlook style: "On DATE, NAME wrote:" + > prefix for ' +
              'text replies, or <blockquote type="cite"> for HTML). Disable to ' +
              'send the bare reply body only.',
          ),
        attachments: z
          .array(attachmentInputSchema)
          .optional()
          .describe(
            `Files to attach: plain paths, or {path, cid, contentType, filename} objects for inline images. Sizes are checked before sending; the base64-encoded total must stay under the account's effective limit (global cap ${sendLimit.globalMb} MB; known provider or per-account limits may be stricter).`,
          ),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (params) => {
      try {
        const prepared = params.attachments?.length
          ? await prepareAttachments(params.attachments, sendLimit.forAccount(params.account))
          : null;
        const result = await smtpService.replyToEmail(params.account, {
          ...params,
          attachments: prepared?.attachments,
        });
        await audit.log(
          'reply_email',
          params.account,
          { emailId: params.emailId, mailbox: params.mailbox, from: result.from },
          'ok',
        );
        return {
          content: [
            {
              type: 'text' as const,
              text: `✅ Reply sent successfully!\nFrom: ${result.from}\nMessage-ID: ${result.messageId}${attachmentReport(prepared)}${sentCopyNote(result.sentCopy)}`,
            },
          ],
        };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        await audit.log(
          'reply_email',
          params.account,
          { emailId: params.emailId, mailbox: params.mailbox },
          'error',
          errMsg,
        );
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Failed to reply: ${errMsg}`,
            },
          ],
        };
      }
    },
  );

  // ---------------------------------------------------------------------------
  // forward_email
  // ---------------------------------------------------------------------------
  server.registerTool(
    'forward_email',
    {
      title: 'Forward email',
      description:
        'Forward an email to new recipients with optional additional message. The original is converted ' +
        'to readable text and "> "-quoted below your note; its attachments are re-attached unless ' +
        'includeAttachments is false. Set html=true to also send an HTML part carrying the original ' +
        'HTML in a blockquote.',
      inputSchema: z.object({
        account: z.string().describe('Account name from list_accounts'),
        from: fromInputSchema,
        emailId: z.string().describe('Email ID to forward (from list_emails or get_email)'),
        mailbox: z.string().default('INBOX').describe('Mailbox where the original email is'),
        to: z.array(z.string().email()).min(1).describe('Forward to these recipients'),
        body: z.string().optional().describe('Additional message above the forwarded content'),
        cc: z.array(z.string().email()).optional().describe('CC recipients'),
        includeAttachments: z
          .boolean()
          .default(true)
          .describe('Re-attach the original attachments (default: true)'),
        html: z
          .boolean()
          .default(false)
          .describe(
            'Also send an HTML part with the original HTML preserved in a blockquote (default: false — text only)',
          ),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (params) => {
      try {
        const result = await smtpService.forwardEmail(params.account, params);
        await audit.log(
          'forward_email',
          params.account,
          { to: params.to, emailId: params.emailId, from: result.from },
          'ok',
        );
        return {
          content: [
            {
              type: 'text' as const,
              text: `✅ Email forwarded successfully!\nFrom: ${result.from}\nTo: ${params.to.join(', ')}\nMessage-ID: ${result.messageId}${params.includeAttachments === false ? '\n(original attachments not included)' : ''}${sentCopyNote(result.sentCopy)}`,
            },
          ],
        };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        await audit.log(
          'forward_email',
          params.account,
          { to: params.to, emailId: params.emailId },
          'error',
          errMsg,
        );
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Failed to forward: ${errMsg}`,
            },
          ],
        };
      }
    },
  );
}
