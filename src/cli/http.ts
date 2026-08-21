/**
 * Streamable HTTP transport entry point ("Method 2", MCP spec 2026-07-28).
 *
 * Serves the same server graph as stdio over HTTP using the SDK v2 node
 * adapter's `NodeStreamableHTTPServerTransport` in stateless mode. Security:
 *   • DNS-rebinding protection via `Host` header validation.
 *   • Bearer-token auth (env `EMAIL_MCP_HTTP_TOKEN` or `--token`).
 *   • Refuses to bind a non-loopback interface without a token (use
 *     `--insecure` to override, e.g. when TLS + auth is terminated upstream).
 *
 * Run:  email-mcp http --port 8080            → http://127.0.0.1:8080/mcp
 *       email-mcp http --host 0.0.0.0 --port 8080 --token "$SECRET"
 */

import { timingSafeEqual } from 'node:crypto';
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';

import {
  hostHeaderValidation,
  NodeStreamableHTTPServerTransport,
} from '@modelcontextprotocol/node';

import { buildServer, buildServices, startBackgroundServices } from '../app.js';

interface HttpOptions {
  host: string;
  port: number;
  path: string;
  token?: string;
  allowedHosts: string[]; // empty ⇒ validation disabled (wildcard)
  insecure: boolean;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost', '[::1]']);

function isLoopback(host: string): boolean {
  return LOOPBACK.has(host);
}

/** Parse `http` subcommand flags, falling back to env vars then defaults. */
function parseOptions(argv: string[]): HttpOptions {
  const env = process.env;
  const opts: HttpOptions = {
    host: env.EMAIL_MCP_HTTP_HOST ?? '127.0.0.1',
    port: Number(env.EMAIL_MCP_HTTP_PORT ?? '8080'),
    path: env.EMAIL_MCP_HTTP_PATH ?? '/mcp',
    token: env.EMAIL_MCP_HTTP_TOKEN,
    allowedHosts: (env.EMAIL_MCP_HTTP_ALLOWED_HOSTS ?? '')
      .split(',')
      .map((h) => h.trim())
      .filter(Boolean),
    insecure: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = argv[i + 1] ?? '';
    switch (arg) {
      case '--host':
        opts.host = value;
        i += 1;
        break;
      case '--port':
        opts.port = Number(value);
        i += 1;
        break;
      case '--path':
        opts.path = value;
        i += 1;
        break;
      case '--token':
        opts.token = value;
        i += 1;
        break;
      case '--allowed-hosts':
        opts.allowedHosts = value
          .split(',')
          .map((h) => h.trim())
          .filter(Boolean);
        i += 1;
        break;
      case '--insecure':
        opts.insecure = true;
        break;
      default:
        // Ignore unknown flags (keeps forward-compatibility).
        break;
    }
  }

  if (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535) {
    throw new Error(`Invalid --port: ${opts.port}`);
  }
  return opts;
}

/** Constant-time bearer-token check. */
function tokenMatches(header: string | undefined, token: string): boolean {
  const prefix = 'Bearer ';
  if (!header?.startsWith(prefix)) return false;
  const provided = Buffer.from(header.slice(prefix.length));
  const expected = Buffer.from(token);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

export default async function runHttp(argv: string[]): Promise<void> {
  const opts = parseOptions(argv);

  // Safety: never expose a networked email server without authentication.
  if (!isLoopback(opts.host) && !opts.token && !opts.insecure) {
    throw new Error(
      `Refusing to bind ${opts.host} without authentication.\n` +
        `Set a token (EMAIL_MCP_HTTP_TOKEN or --token) so requests must present ` +
        `"Authorization: Bearer <token>", or pass --insecure if auth/TLS is ` +
        `terminated by an upstream proxy.`,
    );
  }

  const services = await buildServices();
  const server = buildServer(services);

  // Stateless Streamable HTTP (no session IDs) — matches the 2026-07-28 model.
  const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);

  const background = startBackgroundServices(services, server.server);

  // DNS-rebinding protection. Default to loopback names plus the bind host; a
  // reverse-proxy deployment sets EMAIL_MCP_HTTP_ALLOWED_HOSTS to its public
  // domain (or `*` to disable this check when the proxy already enforces Host).
  const wildcard = opts.allowedHosts.includes('*');
  const hostAllowlist =
    opts.allowedHosts.length > 0
      ? opts.allowedHosts
      : [
          'localhost',
          '127.0.0.1',
          '[::1]',
          ...(isLoopback(opts.host) || opts.host === '0.0.0.0' ? [] : [opts.host]),
        ];
  const validateHost = wildcard ? null : hostHeaderValidation(hostAllowlist);

  const httpServer = createHttpServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? opts.host}`);

      // Unauthenticated, unrestricted health probe (for load balancers).
      if (req.method === 'GET' && url.pathname === '/healthz') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
        return;
      }

      if (url.pathname !== opts.path) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not_found' }));
        return;
      }

      // DNS-rebinding guard answers with 403 itself when it returns false.
      if (validateHost && !validateHost(req, res)) return;

      if (opts.token && !tokenMatches(req.headers.authorization, opts.token)) {
        res.writeHead(401, {
          'content-type': 'application/json',
          'www-authenticate': 'Bearer',
        });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }

      await transport.handleRequest(req, res);
    })().catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[email-mcp] http request error: ${message}\n`);
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
      }
      res.end(JSON.stringify({ error: 'internal_error' }));
    });
  });

  const shutdown = async (): Promise<void> => {
    await background.stop();
    await new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
    });
    await services.connections.closeAll();
    await server.close();
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  await new Promise<void>((resolve) => {
    httpServer.listen(opts.port, opts.host, () => {
      const auth = opts.token ? 'bearer-token auth ON' : 'NO AUTH (loopback only)';
      const hostCheck = wildcard ? 'Host check OFF' : `Host allowlist: ${hostAllowlist.join(', ')}`;
      process.stderr.write(
        `email-mcp — Streamable HTTP on http://${opts.host}:${opts.port}${opts.path} — ${auth}; ${hostCheck}\n`,
      );
      resolve();
    });
  });
}
