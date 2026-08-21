/**
 * MCP tool: list_mailboxes
 */

import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import type ImapService from '../services/imap.service.js';
import { mailboxListOutputSchema } from './schemas.js';

export default function registerMailboxesTools(server: McpServer, imapService: ImapService): void {
  server.registerTool(
    'list_mailboxes',
    {
      title: 'List mailboxes',
      description:
        'List all mailbox folders for an account with unread counts and special-use flags. Use list_accounts first to get the account name.',
      inputSchema: z.object({
        account: z.string().describe('Account name from list_accounts'),
      }),
      outputSchema: mailboxListOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ account }) => {
      try {
        const mailboxes = await imapService.listMailboxes(account);

        const lines = mailboxes.map((mb) => {
          const special = mb.specialUse ? ` [${mb.specialUse}]` : '';
          if (mb.totalMessages === undefined) {
            return `• ${mb.path}${special} — counts unavailable`;
          }
          const badge = mb.unseenMessages ? ` (${mb.unseenMessages} unread)` : '';
          return `• ${mb.path}${special} — ${mb.totalMessages} messages${badge}`;
        });

        return {
          content: [
            {
              type: 'text' as const,
              text: lines.join('\n') || 'No mailboxes found.',
            },
          ],
          structuredContent: { account, count: mailboxes.length, mailboxes },
        };
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Failed to list mailboxes: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    },
  );
}
