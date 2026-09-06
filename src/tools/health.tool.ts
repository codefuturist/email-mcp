/**
 * MCP Tool: check_health
 *
 * Connection health diagnostics for email accounts.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type ConnectionManager from '../connections/manager.js';
import type ImapService from '../services/imap.service.js';
import type { AccountConfig } from '../types/index.js';

/** How the account actually authenticates, as configured. */
function authType(cfg: AccountConfig): 'oauth2' | 'password_command' | 'password' {
  if (cfg.oauth2) return 'oauth2';
  if (cfg.passwordCommand) return 'password_command';
  return 'password';
}

export default function registerHealthTools(
  server: McpServer,
  connections: ConnectionManager,
  imapService: ImapService,
): void {
  server.tool(
    'check_health',
    'Check connection health, quota, and capabilities for email accounts. Useful for diagnosing issues.',
    {
      account: z.string().optional().describe('Account name (checks all accounts if omitted)'),
    },
    { readOnlyHint: true, destructiveHint: false },
    async ({ account }) => {
      const names = account ? [account] : connections.getAccountNames();

      const results = await Promise.all(
        names.map(async (name) => {
          const cfg = connections.getAccount(name);
          const result: Record<string, unknown> = {
            name,
            auth_type: authType(cfg),
          };

          // IMAP health
          try {
            const start = Date.now();
            await connections.getImapClient(name);
            const latency = Date.now() - start;

            const capabilities = await imapService.getCapabilities(name);
            const quota = await imapService.getQuota(name);

            result.imap = {
              connected: true,
              latency_ms: latency,
              host: cfg.imap.host,
              capabilities: capabilities.slice(0, 20),
              tls: cfg.imap.tls,
            };

            if (quota) {
              result.quota = {
                used_mb: quota.usedMb,
                total_mb: quota.totalMb,
                percentage: quota.percentage,
              };
            }
          } catch (err) {
            result.imap = {
              connected: false,
              error: err instanceof Error ? err.message : String(err),
              host: cfg.imap.host,
            };
          }

          // SMTP health
          try {
            const start = Date.now();
            await connections.verifySmtpTransport(name);
            const latency = Date.now() - start;

            result.smtp = {
              connected: true,
              latency_ms: latency,
              host: cfg.smtp.host,
              tls: cfg.smtp.tls,
            };
          } catch (err) {
            result.smtp = {
              connected: false,
              error: err instanceof Error ? err.message : String(err),
              host: cfg.smtp.host,
            };
          }

          return result;
        }),
      );

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ accounts: results }, null, 2),
          },
        ],
      };
    },
  );
}
