/**
 * MCP Resource: email://{account}/stats
 *
 * Dynamic resource providing lightweight daily inbox statistics.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';

import type ConnectionManager from '../connections/manager.js';
import type ImapService from '../services/imap.service.js';

export default function registerStatsResource(
  server: McpServer,
  connections: ConnectionManager,
  imapService: ImapService,
): void {
  const names = connections.getAccountNames();
  const accounts = names.map((name) => connections.getAccount(name));

  server.resource(
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

      // STATUS plus one SEARCH — two round trips, no envelope fetch. This used
      // to call getEmailStats, which fetches envelope and body structure for
      // every message in the period, while the comment here claimed it was a
      // lightweight STATUS query.
      const mailbox = await imapService.getMailboxSnapshot(accountName, 'INBOX');

      const quota = await imapService.getQuota(accountName);

      const snapshot = {
        account: accountName,
        date: new Date().toISOString().split('T')[0],
        // Previously the day's arrivals were reported as the mailbox total too,
        // so inbox_total was wrong on any account with more than a day of mail.
        inbox_total: mailbox.total,
        inbox_unread: mailbox.unread,
        inbox_today: mailbox.receivedToday,
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
