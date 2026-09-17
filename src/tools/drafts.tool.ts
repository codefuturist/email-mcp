/**
 * MCP tools: save_draft, reply_draft, send_draft
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import audit from '../safety/audit.js';

import type ImapService from '../services/imap.service.js';
import type SmtpService from '../services/smtp.service.js';
import attachmentsSchema from './attachment-input.schema.js';

export default function registerDraftTools(
  server: McpServer,
  imapService: ImapService,
  smtpService: SmtpService,
): void {
  // ---------------------------------------------------------------------------
  // save_draft
  // ---------------------------------------------------------------------------
  server.tool(
    'save_draft',
    'Save an email draft to the Drafts folder. Supports file attachments. Compose over time, then use send_draft to send it. Use list_emails with the Drafts mailbox to see saved drafts.',
    {
      account: z.string().describe('Account name from list_accounts'),
      to: z
        .array(z.string().email())
        .default([])
        .describe('Recipient email addresses (can be empty for drafts)'),
      subject: z.string().describe('Email subject'),
      body: z.string().describe('Email body content'),
      cc: z.array(z.string().email()).optional().describe('CC recipients'),
      bcc: z.array(z.string().email()).optional().describe('BCC recipients'),
      html: z.boolean().default(false).describe('Send as HTML (default: plain text)'),
      in_reply_to: z.string().optional().describe('Message-ID for threading (from get_email)'),
      attachments: attachmentsSchema,
    },
    { readOnlyHint: false, destructiveHint: false },
    async ({ account, to, subject, body, cc, bcc, html, in_reply_to: inReplyTo, attachments }) => {
      try {
        const result = await imapService.saveDraft(account, {
          to,
          subject,
          body,
          cc,
          bcc,
          html,
          inReplyTo,
          attachments,
        });

        await audit.log('save_draft', account, { to, subject }, 'ok');

        return {
          content: [
            {
              type: 'text' as const,
              text: `📝 Draft saved (ID: ${result.id}, folder: ${result.mailbox}).`,
            },
          ],
        };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        await audit.log('save_draft', account, { to, subject }, 'error', errMsg);
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Failed to save draft: ${errMsg}`,
            },
          ],
        };
      }
    },
  );

  // ---------------------------------------------------------------------------
  // reply_draft
  // ---------------------------------------------------------------------------
  server.tool(
    'reply_draft',
    'Reply to an existing email and save the reply to the Drafts folder WITHOUT sending it. Works like the Reply button of a mail client (Mailbird): sets In-Reply-To and References, "Re:" subject, reply recipients, and quotes the original under a history_container blockquote that preserves the original HTML so the client can collapse it. Supports file attachments. Nothing is sent; the user reviews and sends the draft from their mail client or with send_draft. Use get_email first to read the original.',
    {
      account: z.string().describe('Account name from list_accounts'),
      emailId: z.string().describe('Email ID to reply to (from list_emails or get_email)'),
      mailbox: z.string().default('INBOX').describe('Mailbox where the original email is'),
      body: z.string().describe('Reply body content (placed above the quoted original)'),
      replyAll: z.boolean().default(false).describe('Reply to all recipients'),
      html: z.boolean().default(false).describe('Body is HTML (default: plain text)'),
      quoteOriginal: z
        .boolean()
        .default(true)
        .describe('Quote the original message below the body'),
      attachments: attachmentsSchema,
    },
    { readOnlyHint: false, destructiveHint: false },
    async (params) => {
      try {
        const result = await imapService.saveReplyDraft(params.account, params);

        await audit.log(
          'reply_draft',
          params.account,
          { emailId: params.emailId, mailbox: params.mailbox, subject: result.subject },
          'ok',
        );

        const ccLine = result.cc.length > 0 ? `\nCc: ${result.cc.join(', ')}` : '';
        return {
          content: [
            {
              type: 'text' as const,
              text: `📝 Reply draft saved (ID: ${result.id}, folder: ${result.mailbox}). Not sent.\nTo: ${result.to.join(', ')}${ccLine}\nSubject: ${result.subject}\nIn-Reply-To: ${result.inReplyTo}`,
            },
          ],
        };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        await audit.log(
          'reply_draft',
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
              text: `Failed to save reply draft: ${errMsg}`,
            },
          ],
        };
      }
    },
  );

  // ---------------------------------------------------------------------------
  // send_draft
  // ---------------------------------------------------------------------------
  server.tool(
    'send_draft',
    'Send an existing draft email and remove it from Drafts. The draft (including any attachments saved with it) is fetched, sent via SMTP, then deleted. Use list_emails with the Drafts mailbox to find draft IDs.',
    {
      account: z.string().describe('Account name from list_accounts'),
      id: z.number().int().describe('Draft email UID (from list_emails on Drafts mailbox)'),
      mailbox: z.string().optional().describe('Drafts folder path (auto-detected if omitted)'),
    },
    { readOnlyHint: false, destructiveHint: true },
    async ({ account, id, mailbox }) => {
      try {
        const result = await smtpService.sendDraft(account, id, mailbox);

        await audit.log('send_draft', account, { id, mailbox }, 'ok');

        return {
          content: [
            {
              type: 'text' as const,
              text: `✅ Draft sent (Message-ID: ${result.messageId}). Draft removed from folder.`,
            },
          ],
        };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        await audit.log('send_draft', account, { id, mailbox }, 'error', errMsg);
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Failed to send draft: ${errMsg}`,
            },
          ],
        };
      }
    },
  );
}
