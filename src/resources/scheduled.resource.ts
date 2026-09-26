/**
 * MCP Resource: email://scheduled
 *
 * Static resource listing pending scheduled emails.
 */

import type { McpServer } from '@modelcontextprotocol/server';

import type SchedulerService from '../services/scheduler.service.js';

export default function registerScheduledResource(
  server: McpServer,
  schedulerService: SchedulerService,
): void {
  server.registerResource(
    'scheduled',
    'email://scheduled',
    { description: 'List of pending scheduled emails' },
    async () => {
      const emails = await schedulerService.list({
        status: 'pending',
      });

      const summary = emails.map((e) => ({
        id: e.id,
        account: e.account,
        to: e.to.join(', '),
        subject: e.subject,
        send_at: e.sendAt,
        created_at: e.createdAt,
        overdue: new Date(e.sendAt).getTime() < Date.now(),
      }));

      return {
        contents: [
          {
            uri: 'email://scheduled',
            mimeType: 'application/json',
            text: JSON.stringify({ pending: summary, count: summary.length }, null, 2),
          },
        ],
      };
    },
  );
}
