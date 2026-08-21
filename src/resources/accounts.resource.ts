/**
 * MCP Resource: email://accounts
 *
 * Static resource listing all configured email accounts.
 */

import type { McpServer } from '@modelcontextprotocol/server';

import type ConnectionManager from '../connections/manager.js';

export default function registerAccountsResource(
  server: McpServer,
  connections: ConnectionManager,
): void {
  const names = connections.getAccountNames();
  const accounts = names.map((name) => {
    const cfg = connections.getAccount(name);
    return {
      name: cfg.name,
      email: cfg.email,
      fullName: cfg.fullName ?? undefined,
    };
  });

  server.registerResource(
    'accounts',
    'email://accounts',
    { description: 'List of all configured email accounts' },
    async () => ({
      contents: [
        {
          uri: 'email://accounts',
          mimeType: 'application/json',
          text: JSON.stringify(accounts, null, 2),
        },
      ],
    }),
  );
}
