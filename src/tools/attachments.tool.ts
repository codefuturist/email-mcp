/**
 * MCP tool: download_attachment
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type ImapService from '../services/imap.service.js';
import type { AppConfig } from '../types/index.js';

export default function registerAttachmentTools(
  server: McpServer,
  imapService: ImapService,
  config: AppConfig,
): void {
  server.tool(
    'download_attachment',
    'Download an email attachment by filename. First use get_email to see available attachments and their filenames. ' +
      'By default returns base64-encoded content for files ≤5MB. ' +
      'Set save_to_download_dir=true to write the file into the server-configured attachment download directory ' +
      'and return only metadata (path, size, mime) — preferred for large files and for handing off to another MCP by path.',
    {
      account: z.string().describe('Account name from list_accounts'),
      id: z.string().describe('Email ID (UID) from list_emails or get_email'),
      mailbox: z.string().default('INBOX').describe('Mailbox containing the email'),
      filename: z.string().describe('Exact attachment filename (from get_email metadata)'),
      save_to_download_dir: z
        .boolean()
        .default(false)
        .describe(
          'When true, save into MCP_EMAIL_ATTACHMENT_DOWNLOAD_DIR (or settings.attachment_download.dir) and omit base64. Requires the download dir to be configured.',
        ),
      save_as: z
        .string()
        .optional()
        .describe(
          'Optional basename only for the downloaded file (no paths). Defaults to a sanitized attachment filename. Ignored unless save_to_download_dir=true.',
        ),
    },
    { readOnlyHint: true, destructiveHint: false },
    async ({
      account,
      id,
      mailbox,
      filename,
      save_to_download_dir: saveToDownloadDir,
      save_as: saveAs,
    }) => {
      try {
        if (saveToDownloadDir) {
          const downloadDir = config.settings.attachmentDownload.dir;
          if (!downloadDir) {
            return {
              isError: true,
              content: [
                {
                  type: 'text' as const,
                  text:
                    'Attachment download directory is not configured. Set MCP_EMAIL_ATTACHMENT_DOWNLOAD_DIR ' +
                    '(or EMAIL_ATTACHMENT_DOWNLOAD_DIR) or [settings.attachment_download] dir in config.toml ' +
                    'before using save_to_download_dir=true.',
                },
              ],
            };
          }

          const result = await imapService.downloadAttachmentToDownloadDir(
            account,
            id,
            mailbox,
            filename,
            {
              downloadDir,
              allowedExtensions: config.settings.attachmentDownload.allowedExtensions,
              maxBytes: config.settings.attachmentDownload.maxBytes,
              saveAs,
            },
          );

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
                    savedTo: result.savedTo,
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }

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
