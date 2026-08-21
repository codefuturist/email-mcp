/**
 * MCP tool: bulk_action — batch operations on multiple emails.
 */

import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import audit from '../safety/audit.js';

import type ImapService from '../services/imap.service.js';
import type { BulkResult } from '../types/index.js';

export default function registerBulkTools(server: McpServer, imapService: ImapService): void {
  server.registerTool(
    'bulk_action',
    {
      title: 'Bulk action',
      description:
        'Batch operation on multiple emails by UID list. Supports mark_read, mark_unread, flag, unflag, move, and delete. Max 100 IDs per call. Returns success/failure counts.',
      inputSchema: z.object({
        account: z.string().describe('Account name from list_accounts'),
        mailbox: z.string().default('INBOX').describe('Source mailbox containing the emails'),
        action: z
          .enum(['mark_read', 'mark_unread', 'flag', 'unflag', 'move', 'delete'])
          .describe('Bulk action to perform'),
        ids: z
          .array(z.number().int())
          .min(1)
          .max(100)
          .describe('Array of email UIDs (max 100). Get UIDs from list_emails or search_emails.'),
        destination: z
          .string()
          .optional()
          .describe("Destination mailbox — required when action is 'move'"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ account, mailbox, action, ids, destination }) => {
      try {
        if (action === 'move' && !destination) {
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: `Destination mailbox is required for "move" action.`,
              },
            ],
          };
        }

        let result: BulkResult;
        if (action === 'move') {
          result = await imapService.bulkMove(account, ids, mailbox, destination as string);
        } else if (action === 'delete') {
          result = await imapService.bulkDelete(account, ids, mailbox);
        } else {
          result = await imapService.bulkSetFlags(account, ids, mailbox, action);
        }

        await audit.log(
          'bulk_action',
          account,
          {
            mailbox,
            action,
            ids: ids.length,
            destination,
          },
          'ok',
        );

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        await audit.log(
          'bulk_action',
          account,
          { mailbox, action, ids: ids.length },
          'error',
          errMsg,
        );
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Bulk action failed: ${errMsg}`,
            },
          ],
        };
      }
    },
  );
}
