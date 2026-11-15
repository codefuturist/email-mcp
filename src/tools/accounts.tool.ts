/**
 * MCP tool: list_accounts
 */

import type { McpServer } from '@modelcontextprotocol/server';

import type ConnectionManager from '../connections/manager.js';

export default function registerAccountsTools(
  server: McpServer,
  connections: ConnectionManager,
): void {
  server.registerTool(
    'list_accounts',
    {
      title: 'List accounts',
      description:
        'List all configured email accounts and the extra sender identities (aliases) each may send as. Call this first to discover available account names for use with other tools.',
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async () => {
      const names = connections.getAccountNames();
      const accounts = names.map((name) => {
        const cfg = connections.getAccount(name);
        return {
          name: cfg.name,
          email: cfg.email,
          fullName: cfg.fullName ?? null,
          identities: cfg.identities ?? [],
        };
      });

      return {
        content: [
          {
            type: 'text' as const,
            text:
              accounts.length > 0
                ? accounts
                    .map(
                      (a) =>
                        `• ${a.name}: ${a.email}${a.fullName ? ` (${a.fullName})` : ''}` +
                        // Aliases the send tools accept as `from`.
                        a.identities
                          .map(
                            (i) =>
                              `\n    also sends as: ${i.email}${i.fullName ? ` (${i.fullName})` : ''}`,
                          )
                          .join(''),
                    )
                    .join('\n')
                : 'No accounts configured.',
          },
        ],
      };
    },
  );
}
