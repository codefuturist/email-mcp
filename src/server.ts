/**
 * MCP Server factory.
 *
 * Creates and configures the McpServer instance (MCP TypeScript SDK v2,
 * spec revision 2026-07-28). Tools, resources and prompts are registered
 * by the caller (see `buildServer` in `main.ts`) so the same factory serves
 * both stdio and Streamable HTTP transports.
 */

import { McpServer } from '@modelcontextprotocol/server';

import { PKG_VERSION } from './version.js';

export const PKG_NAME = 'email-mcp';
export { PKG_VERSION };

const INSTRUCTIONS = `Email MCP server exposing IMAP + SMTP over the Model Context Protocol.
Start by calling \`list_accounts\` to discover configured accounts, then use
\`list_emails\`/\`search_emails\` to browse and \`get_email\` to read. Reading is
non-destructive by default (IMAP BODY.PEEK). Write tools (send, drafts, labels,
folders, scheduling) are hidden when the server runs in read-only mode.`;

export default function createServer(): McpServer {
  return new McpServer(
    {
      name: PKG_NAME,
      version: PKG_VERSION,
    },
    {
      // Note: the `logging` capability is deprecated as of spec 2026-07-28
      // (SEP-2577); this server logs to stderr instead (see `logging.ts`).
      capabilities: {
        tools: { listChanged: true },
        prompts: { listChanged: true },
        resources: { subscribe: true, listChanged: true },
      },
      instructions: INSTRUCTIONS,
    },
  );
}
