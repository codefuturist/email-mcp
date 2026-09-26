/**
 * MCP Resource: email://{account}/mailboxes
 *
 * Dynamic resource providing the mailbox folder tree with message counts.
 */

import type { McpServer } from '@modelcontextprotocol/server';
import { ResourceTemplate } from '@modelcontextprotocol/server';

import type ConnectionManager from '../connections/manager.js';
import type ImapService from '../services/imap.service.js';

export default function registerMailboxesResource(
  server: McpServer,
  connections: ConnectionManager,
  imapService: ImapService,
): void {
  const names = connections.getAccountNames();
  const accounts = names.map((name) => connections.getAccount(name));

  server.registerResource(
    'mailboxes',
    new ResourceTemplate('email://{account}/mailboxes', {
      list: async () => ({
        resources: accounts.map((a) => ({
          uri: `email://${a.name}/mailboxes`,
          name: `${a.name} — Mailbox tree`,
          description: `Folder structure and message counts for ${a.email}`,
          mimeType: 'application/json',
        })),
      }),
    }),
    { description: 'Mailbox folder tree with message counts for an account' },
    async (uri, { account }) => {
      const accountName = account as string;
      const mailboxes = await imapService.listMailboxes(accountName);

      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify(mailboxes, null, 2),
          },
        ],
      };
    },
  );
}
