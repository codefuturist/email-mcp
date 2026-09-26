/**
 * MCP tool: find_email_folder
 *
 * Locates the real mailbox folder(s) containing an email.
 * Essential when working with virtual folders like "All Mail" or "Starred",
 * which don't support IMAP MOVE operations.
 */

import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import type ImapService from '../services/imap.service.js';

export default function registerLocateTools(server: McpServer, imapService: ImapService): void {
  server.registerTool(
    'find_email_folder',
    {
      title: 'Find email folder',
      description:
        'Find which real mailbox folder(s) an email belongs to. ' +
        'Required before move_email or delete_email when the email was found in a virtual folder ' +
        '(e.g., "All Mail", "Starred"). Returns the real folder path to use as sourceMailbox.',
      inputSchema: z.object({
        account: z.string().describe('Account name from list_accounts'),
        emailId: z.string().describe('Email ID (UID) from list_emails'),
        sourceMailbox: z
          .string()
          .default('INBOX')
          .describe('Mailbox where the email is currently visible (e.g., "All Mail")'),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ account, emailId, sourceMailbox }) => {
      try {
        const { folders, messageId } = await imapService.findEmailFolder(
          account,
          emailId,
          sourceMailbox,
        );

        if (folders.length === 0) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `No real folder found for email ${emailId}. It may only exist in virtual folders.`,
              },
            ],
          };
        }

        const lines = [
          `📁 Email ${emailId} found in ${folders.length} folder(s):`,
          ...folders.map((f) => `  • ${f}`),
          '',
          `Use the first folder as sourceMailbox for move_email or delete_email.`,
        ];
        if (messageId) {
          lines.push(`Message-ID: ${messageId}`);
        }

        return {
          content: [{ type: 'text' as const, text: lines.join('\n') }],
        };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Failed to locate email: ${errMsg}`,
            },
          ],
        };
      }
    },
  );
}
