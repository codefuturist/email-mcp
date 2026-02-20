/**
 * MCP protocol logging bridge.
 *
 * Forwards structured log messages to the connected MCP client
 * via the logging notification channel declared in server capabilities.
 *
 * Messages are silently dropped until `markInitialized()` is called,
 * which should happen only after the MCP `initialized` handshake
 * completes.  This prevents pre-handshake notifications from being
 * written to stdout and breaking clients.
 *
 * Usage:
 *   bindServer(server)       — call once after creating the McpServer
 *   markInitialized()        — call from the `oninitialized` callback
 *   mcpLog("info", …)        — fire-and-forget from anywhere
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

type LogLevel =
  | 'debug'
  | 'info'
  | 'notice'
  | 'warning'
  | 'error'
  | 'critical'
  | 'alert'
  | 'emergency';

let mcpServerRef: McpServer | null = null;

/** `true` only after the client has completed the MCP `initialized` handshake. */
let initialized = false;

/**
 * Bind an McpServer instance so subsequent `mcpLog()` calls
 * are forwarded to the connected client.
 */
export function bindServer(server: McpServer): void {
  mcpServerRef = server;
}

/**
 * Mark the server as fully initialized (handshake complete).
 *
 * Call this from the `server.server.oninitialized` callback so that
 * `mcpLog()` starts forwarding messages to the client.
 */
export function markInitialized(): void {
  initialized = true;
}

/**
 * Reset module state.  **Test-only** — never call in production.
 * @internal
 */
// eslint-disable-next-line @typescript-eslint/naming-convention, no-underscore-dangle
export function __resetForTesting(): void {
  mcpServerRef = null;
  initialized = false;
}

/**
 * Emit a structured log message over the MCP logging channel.
 *
 * Safe to call at any point — silently dropped when:
 *   • the server hasn't been bound yet
 *   • the transport isn't connected
 *   • the MCP handshake hasn't completed (`markInitialized()` not called)
 */
export async function mcpLog(level: LogLevel, logger: string, data: unknown): Promise<void> {
  if (!initialized || !mcpServerRef?.isConnected()) return;
  try {
    await mcpServerRef.sendLoggingMessage({ level, logger, data });
  } catch {
    // Never let a logging failure break tool execution
  }
}
