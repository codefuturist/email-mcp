/**
 * MCP tools for the AgentMail provider.
 *
 * These tools are registered **alongside** the existing IMAP/SMTP tools when
 * the user has configured an AgentMail API key.  They are prefixed with
 * `agentmail_` to avoid name collisions.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import audit from '../safety/audit.js';
import type AgentMailService from '../services/agentmail.service.js';

export default function registerAgentMailTools(
  server: McpServer,
  agentMailService: AgentMailService,
): void {
  // ---------------------------------------------------------------------------
  // agentmail_create_inbox
  // ---------------------------------------------------------------------------
  server.tool(
    'agentmail_create_inbox',
    'Create a new AgentMail inbox. Returns the inbox ID and email address. ' +
      'Each inbox gets a unique @agentmail.to address that can send and receive email immediately.',
    {
      displayName: z
        .string()
        .optional()
        .describe('Human-readable name for the inbox (e.g. "Support Agent")'),
    },
    { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    async (params) => {
      try {
        const inbox = await agentMailService.createInbox(params.displayName);
        await audit.log('agentmail_create_inbox', 'agentmail', { displayName: params.displayName }, 'ok');
        return {
          content: [
            {
              type: 'text' as const,
              text: `✅ Inbox created!\nID: ${inbox.inboxId}\nEmail: ${inbox.email}\nName: ${inbox.displayName ?? '(default)'}`,
            },
          ],
        };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        await audit.log('agentmail_create_inbox', 'agentmail', { displayName: params.displayName }, 'error', errMsg);
        return {
          isError: true,
          content: [{ type: 'text' as const, text: `Failed to create inbox: ${errMsg}` }],
        };
      }
    },
  );

  // ---------------------------------------------------------------------------
  // agentmail_list_inboxes
  // ---------------------------------------------------------------------------
  server.tool(
    'agentmail_list_inboxes',
    'List all AgentMail inboxes associated with the configured API key.',
    {},
    { readOnlyHint: true, destructiveHint: false },
    async () => {
      try {
        const inboxes = await agentMailService.listInboxes();
        if (inboxes.length === 0) {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'No AgentMail inboxes found. Use agentmail_create_inbox to create one.',
              },
            ],
          };
        }
        const lines = inboxes.map((m) => `📬 ${m.name} (${m.path})`);
        return {
          content: [
            {
              type: 'text' as const,
              text: `Found ${inboxes.length} inbox(es):\n\n${lines.join('\n')}`,
            },
          ],
        };
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Failed to list inboxes: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    },
  );

  // ---------------------------------------------------------------------------
  // agentmail_list_messages
  // ---------------------------------------------------------------------------
  server.tool(
    'agentmail_list_messages',
    'List messages in an AgentMail inbox. Returns message metadata including subject, sender, and date.',
    {
      inboxId: z.string().describe('AgentMail inbox ID (from agentmail_list_inboxes or agentmail_create_inbox)'),
      page: z.number().int().min(1).default(1).describe('Page number'),
      pageSize: z.number().int().min(1).max(100).default(20).describe('Results per page'),
    },
    { readOnlyHint: true, destructiveHint: false },
    async (params) => {
      try {
        const result = await agentMailService.listMessages(params.inboxId, {
          page: params.page,
          pageSize: params.pageSize,
        });

        if (result.items.length === 0) {
          return {
            content: [{ type: 'text' as const, text: 'No messages found in this inbox.' }],
          };
        }

        const emails = result.items
          .map((e) => {
            const from = e.from.name ? `${e.from.name} <${e.from.address}>` : e.from.address;
            return `[${e.id}] ${e.subject}\n  From: ${from} | ${e.date}${e.preview ? `\n  ${e.preview}` : ''}`;
          })
          .join('\n\n');

        return {
          content: [
            {
              type: 'text' as const,
              text: `📬 ${result.total} message(s) (page ${result.page})${result.hasMore ? ' — more available' : ''}\n\n${emails}`,
            },
          ],
        };
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Failed to list messages: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    },
  );

  // ---------------------------------------------------------------------------
  // agentmail_get_message
  // ---------------------------------------------------------------------------
  server.tool(
    'agentmail_get_message',
    'Get the full content of a specific AgentMail message by ID. ' +
      'AgentMail provides an extracted_text field that automatically strips quoted reply chains ' +
      'for cleaner AI processing.',
    {
      inboxId: z.string().describe('AgentMail inbox ID'),
      messageId: z.string().describe('Message ID from agentmail_list_messages'),
    },
    { readOnlyHint: true, destructiveHint: false },
    async (params) => {
      try {
        const email = await agentMailService.getMessage(params.inboxId, params.messageId);

        const from = email.from.name
          ? `${email.from.name} <${email.from.address}>`
          : email.from.address;
        const to = email.to.map((a) => (a.name ? `${a.name} <${a.address}>` : a.address)).join(', ');

        const parts = [
          `📧 ${email.subject}`,
          `From:   ${from}`,
          `To:     ${to}`,
          `Date:   ${email.date}`,
          `ID:     ${email.messageId}`,
        ];

        if (email.attachments.length > 0) {
          parts.push(
            `📎 Attachments: ${email.attachments.map((a) => `${a.filename} (${a.mimeType})`).join(', ')}`,
          );
        }

        parts.push('', '--- Body ---', '');
        parts.push(email.bodyText ?? email.bodyHtml ?? '(no content)');

        return {
          content: [{ type: 'text' as const, text: parts.join('\n') }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Failed to get message: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    },
  );

  // ---------------------------------------------------------------------------
  // agentmail_send_message
  // ---------------------------------------------------------------------------
  server.tool(
    'agentmail_send_message',
    'Send an email from an AgentMail inbox. Supports plain text or HTML body.',
    {
      inboxId: z.string().describe('AgentMail inbox ID to send from'),
      to: z.array(z.string().email()).min(1).describe('Recipient email addresses'),
      subject: z.string().describe('Email subject'),
      body: z.string().describe('Email body content'),
      html: z.boolean().default(false).describe('Send as HTML (default: plain text)'),
    },
    { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    async (params) => {
      try {
        const result = await agentMailService.sendMessage(params.inboxId, {
          to: params.to,
          subject: params.subject,
          body: params.body,
          html: params.html,
        });
        await audit.log(
          'agentmail_send_message',
          'agentmail',
          { to: params.to, subject: params.subject },
          'ok',
        );
        return {
          content: [
            {
              type: 'text' as const,
              text: `✅ Email sent via AgentMail!\nTo: ${params.to.join(', ')}\nSubject: ${params.subject}\nMessage-ID: ${result.messageId}`,
            },
          ],
        };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        await audit.log(
          'agentmail_send_message',
          'agentmail',
          { to: params.to, subject: params.subject },
          'error',
          errMsg,
        );
        return {
          isError: true,
          content: [{ type: 'text' as const, text: `Failed to send email: ${errMsg}` }],
        };
      }
    },
  );
}
