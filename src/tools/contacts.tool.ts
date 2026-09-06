/**
 * MCP tool: extract_contacts
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type ImapService from '../services/imap.service.js';

export default function registerContactsTools(server: McpServer, imapService: ImapService): void {
  server.tool(
    'extract_contacts',
    'Extract unique contacts from recent email headers. Returns contacts sorted by frequency (most frequent first). Useful for finding frequent correspondents or building an address book.',
    {
      account: z.string().describe('Account name from list_accounts'),
      mailbox: z.string().optional().describe('Mailbox to scan (default: INBOX)'),
      limit: z.coerce
        .number()
        .int()
        .min(1)
        .max(500)
        .default(100)
        .describe('Number of recent emails to scan (default: 100, max: 500)'),
    },
    { readOnlyHint: true, destructiveHint: false },
    async ({ account, mailbox, limit }) => {
      try {
        const contacts = await imapService.extractContacts(account, {
          mailbox,
          limit,
        });

        return {
          content: [
            {
              type: 'text' as const,
              text: `Found ${contacts.length} unique contacts from ${limit} recent emails:\n\n${JSON.stringify(contacts, null, 2)}`,
            },
          ],
        };
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Failed to extract contacts: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    },
  );
}
