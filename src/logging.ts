/**
 * Structured logging for the Email MCP server.
 *
 * As of MCP 2026-07-28 the `logging` capability and the server→client
 * `notifications/message` channel are deprecated (SEP-2577). For a stdio
 * server the correct, always-safe sink is **stderr**: it never pollutes the
 * JSON-RPC stream on stdout, needs no handshake gating, and is surfaced by
 * MCP clients (Claude Desktop, Cursor, …) as server logs.
 *
 * `mcpLog()` keeps its original fire-and-forget `Promise<void>` signature so
 * the many existing call sites (`await mcpLog(…)` and `mcpLog(…).catch(…)`)
 * are unchanged.
 */

export type LogLevel =
  | 'debug'
  | 'info'
  | 'notice'
  | 'warning'
  | 'error'
  | 'critical'
  | 'alert'
  | 'emergency';

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Emit a structured log line to stderr.
 *
 * Safe to call anywhere, at any time — stderr is always protocol-safe for
 * stdio transports, so there is no pre-handshake window to guard against.
 */
export function mcpLog(level: LogLevel, logger: string, data: unknown): Promise<void> {
  const message = typeof data === 'string' ? data : safeStringify(data);
  process.stderr.write(
    `${new Date().toISOString()} ${level.toUpperCase()} [${logger}] ${message}\n`,
  );
  return Promise.resolve();
}
