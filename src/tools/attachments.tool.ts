/**
 * MCP tool: download_attachment
 */

import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import type ImapService from '../services/imap.service.js';

export default function registerAttachmentTools(server: McpServer, imapService: ImapService): void {
  server.registerTool(
    'download_attachment',
    {
      title: 'Download attachment',
      description:
        'Download an email attachment by filename. First use get_email to see available attachments and their filenames. Returns base64-encoded content for files ≤5MB.',
      inputSchema: z.object({
        account: z.string().describe('Account name from list_accounts'),
        id: z.string().describe('Email ID (UID) from list_emails or get_email'),
        mailbox: z.string().default('INBOX').describe('Mailbox containing the email'),
        filename: z.string().describe('Exact attachment filename (from get_email metadata)'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ account, id, mailbox, filename }) => {
      try {
        const result = await imapService.downloadAttachment(account, id, mailbox, filename);

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  filename: result.filename,
                  mimeType: result.mimeType,
                  size: result.size,
                  sizeHuman: `${Math.round(result.size / 1024)}KB`,
                },
                null,
                2,
              ),
            },
            {
              type: 'text' as const,
              text: `\n--- Base64 Content ---\n${result.contentBase64}`,
            },
          ],
        };
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Failed to download attachment: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    },
  );
}
