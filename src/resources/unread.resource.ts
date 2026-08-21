/**
 * MCP Resource: email://{account}/unread
 *
 * Dynamic resource providing an unread email summary per folder.
 * Only includes folders with unread messages.
 */

import type { McpServer } from '@modelcontextprotocol/server';
import { ResourceTemplate } from '@modelcontextprotocol/server';

import type ConnectionManager from '../connections/manager.js';
import type ImapService from '../services/imap.service.js';

export default function registerUnreadResource(
  server: McpServer,
  connections: ConnectionManager,
  imapService: ImapService,
): void {
  const names = connections.getAccountNames();
  const accounts = names.map((name) => connections.getAccount(name));

  server.registerResource(
    'unread',
    new ResourceTemplate('email://{account}/unread', {
      list: async () => ({
        resources: accounts.map((a) => ({
          uri: `email://${a.name}/unread`,
          name: `${a.name} — Unread summary`,
          description: `Unread email counts by folder for ${a.email}`,
          mimeType: 'application/json',
        })),
      }),
    }),
    { description: 'Unread email count summary by folder for an account' },
    async (uri, { account }) => {
      const accountName = account as string;
      const mailboxes = await imapService.listMailboxes(accountName);

      const unreadFolders = mailboxes
        .filter((mb) => mb.unseenMessages !== undefined && mb.unseenMessages > 0)
        .map((mb) => ({
          path: mb.path,
          unread: mb.unseenMessages as number,
        }));

      // Folders whose STATUS call failed have an unknown unread count, so
      // totalUnread is a lower bound rather than a fact. Say so instead of
      // letting the consumer read an incomplete total as complete.
      const incompleteFolders = mailboxes
        .filter((mb) => mb.unseenMessages === undefined)
        .map((mb) => mb.path);

      const totalUnread = unreadFolders.reduce((sum, f) => sum + f.unread, 0);

      const summary = {
        account: accountName,
        totalUnread,
        folders: unreadFolders,
        ...(incompleteFolders.length > 0 ? { incompleteFolders } : {}),
      };

      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify(summary, null, 2),
          },
        ],
      };
    },
  );
}
