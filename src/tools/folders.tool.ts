/**
 * MCP tools: create_mailbox, rename_mailbox, delete_mailbox
 */

import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import audit from '../safety/audit.js';

import type ImapService from '../services/imap.service.js';

export default function registerFolderTools(server: McpServer, imapService: ImapService): void {
  // ---------------------------------------------------------------------------
  // create_mailbox
  // ---------------------------------------------------------------------------
  server.registerTool(
    'create_mailbox',
    {
      title: 'Create mailbox',
      description:
        "Create a new mailbox (folder). Use '/' as separator for nested folders (e.g., 'Work/Projects'). Use list_mailboxes to see existing folders.",
      inputSchema: z.object({
        account: z.string().describe('Account name from list_accounts'),
        path: z
          .string()
          .min(1)
          .describe("Folder path to create (e.g., 'Archive/2026' or 'Projects')"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ account, path: folderPath }) => {
      try {
        await imapService.createMailbox(account, folderPath);
        await audit.log('create_mailbox', account, { path: folderPath }, 'ok');
        return {
          content: [
            {
              type: 'text' as const,
              text: `📁 Mailbox "${folderPath}" created.`,
            },
          ],
        };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        await audit.log('create_mailbox', account, { path: folderPath }, 'error', errMsg);
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Failed to create mailbox: ${errMsg}`,
            },
          ],
        };
      }
    },
  );

  // ---------------------------------------------------------------------------
  // rename_mailbox
  // ---------------------------------------------------------------------------
  server.registerTool(
    'rename_mailbox',
    {
      title: 'Rename mailbox',
      description:
        'Rename an existing mailbox (folder). Use list_mailboxes to see current folder paths.',
      inputSchema: z.object({
        account: z.string().describe('Account name from list_accounts'),
        path: z.string().min(1).describe('Current folder path'),
        new_path: z.string().min(1).describe('New folder path'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ account, path: folderPath, new_path: newPath }) => {
      try {
        await imapService.renameMailbox(account, folderPath, newPath);
        await audit.log('rename_mailbox', account, { path: folderPath, new_path: newPath }, 'ok');
        return {
          content: [
            {
              type: 'text' as const,
              text: `📁 Mailbox renamed from "${folderPath}" to "${newPath}".`,
            },
          ],
        };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        await audit.log(
          'rename_mailbox',
          account,
          { path: folderPath, new_path: newPath },
          'error',
          errMsg,
        );
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Failed to rename mailbox: ${errMsg}`,
            },
          ],
        };
      }
    },
  );

  // ---------------------------------------------------------------------------
  // delete_mailbox
  // ---------------------------------------------------------------------------
  server.registerTool(
    'delete_mailbox',
    {
      title: 'Delete mailbox',
      description:
        '⚠️ DESTRUCTIVE: Permanently delete a mailbox and ALL its contents. This cannot be undone. Use list_mailboxes to verify the folder path.',
      inputSchema: z.object({
        account: z.string().describe('Account name from list_accounts'),
        path: z
          .string()
          .min(1)
          .describe('Folder path to delete (⚠️ all emails inside will be lost)'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ account, path: folderPath }) => {
      try {
        await imapService.deleteMailbox(account, folderPath);
        await audit.log('delete_mailbox', account, { path: folderPath }, 'ok');
        return {
          content: [
            {
              type: 'text' as const,
              text: `⚠️ Mailbox "${folderPath}" permanently deleted.`,
            },
          ],
        };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        await audit.log('delete_mailbox', account, { path: folderPath }, 'error', errMsg);
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Failed to delete mailbox: ${errMsg}`,
            },
          ],
        };
      }
    },
  );
}
