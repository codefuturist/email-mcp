import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

import type HooksService from './services/hooks.service.js';

type LogLevel =
  | 'debug'
  | 'info'
  | 'notice'
  | 'warning'
  | 'error'
  | 'critical'
  | 'alert'
  | 'emergency';

interface CreateHttpHandlerDeps {
  buildMcpSession: () => McpServer;
  transports: Map<string, StreamableHTTPServerTransport>;
  hooksService: HooksService;
  markInitialized: () => void;
  mcpLog: (level: LogLevel, logger: string, data: unknown) => Promise<void>;
  PKG_VERSION: string;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
// eslint-disable-next-line import-x/prefer-default-export
export function createHttpHandler(
  deps: CreateHttpHandlerDeps,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const { buildMcpSession, hooksService, markInitialized, mcpLog, PKG_VERSION, transports } = deps;

  return async (req: IncomingMessage, res: ServerResponse) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, version: PKG_VERSION }));
      return;
    }

    if (req.url !== '/mcp') {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }

    let body: unknown;
    if (req.method === 'POST') {
      const raw = await readBody(req);
      if (raw.length > 0) {
        try {
          body = JSON.parse(raw.toString());
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              error: { code: -32700, message: 'Parse error' },
              id: null,
            }),
          );
          return;
        }
      }
    }

    const sessionIdHeader = req.headers['mcp-session-id'];
    const sessionId = Array.isArray(sessionIdHeader) ? sessionIdHeader[0] : sessionIdHeader;
    let transport: StreamableHTTPServerTransport | undefined;

    if (sessionId && transports.has(sessionId)) {
      transport = transports.get(sessionId);
    } else if (!sessionId && req.method === 'POST' && isInitializeRequest(body)) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
          transports.set(sid, transport!);
        },
      });
      transport.onclose = () => {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const sid = transport!.sessionId;
        if (sid) transports.delete(sid);
      };
      const mcpServer = buildMcpSession();
      await mcpServer.connect(transport);

      const ls = mcpServer.server;
      ls.oninitialized = () => {
        markInitialized();
        // eslint-disable-next-line no-void
        void (async () => {
          try {
            const clientCaps = ls.getClientCapabilities?.() ?? {};
            hooksService.start(ls, { sampling: clientCaps.sampling != null });
            await mcpLog('info', 'server', 'Email MCP server ready (HTTP mode)');
          } catch (err) {
            process.stderr.write(
              `[email-mcp] hooks init error: ${err instanceof Error ? err.message : String(err)}\n`,
            );
          }
        })();
      };
    } else {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          error: {
            code: -32000,
            message: 'Bad Request: provide mcp-session-id or send an initialize request',
          },
          id: null,
        }),
      );
      return;
    }

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    await transport!.handleRequest(req, res, body);
  };
}
