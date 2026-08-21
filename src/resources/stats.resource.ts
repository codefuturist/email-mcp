/**
 * MCP Resource: email://{account}/stats
 *
 * Dynamic resource providing lightweight daily inbox statistics.
 */

import type { McpServer } from '@modelcontextprotocol/server';
import { ResourceTemplate } from '@modelcontextprotocol/server';

import type ConnectionManager from '../connections/manager.js';
import type ImapService from '../services/imap.service.js';

export default function registerStatsResource(
  server: McpServer,
  connections: ConnectionManager,
  imapService: ImapService,
): void {
  const names = connections.getAccountNames();
  const accounts = names.map((name) => connections.getAccount(name));

  server.registerResource(
    'stats',
    new ResourceTemplate('email://{account}/stats', {
      list: async () => ({
        resources: accounts.map((a) => ({
          uri: `email://${a.name}/stats`,
          name: `${a.name} — Inbox Stats`,
          description: `Email statistics snapshot for ${a.email}`,
          mimeType: 'application/json',
        })),
      }),
    }),
    {
      description: 'Daily inbox statistics snapshot with unread count and quota',
    },
    async (uri, { account }) => {
      const accountName = account as string;

      // NOT a lightweight STATUS query, despite what this comment used to
      // claim: getEmailStats runs SEARCH SINCE and then fetches envelope,
      // flags and bodyStructure for every UID in the window, unbounded.
      // On a busy INBOX this is one of the most expensive reads in the server.
      const stats = await imapService.getEmailStats(accountName, 'INBOX', 'day');

      const quota = await imapService.getQuota(accountName);

      const snapshot = {
        account: accountName,
        date: new Date().toISOString().split('T')[0],
        inbox_total: stats.totalReceived,
        inbox_unread: stats.unreadCount,
        inbox_today: stats.totalReceived,
        quota: quota ?? undefined,
      };

      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify(snapshot, null, 2),
          },
        ],
      };
    },
  );
}
