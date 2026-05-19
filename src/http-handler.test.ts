import { EventEmitter } from 'node:events';
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';

import { createHttpHandler } from './http-handler.js';

interface MockTransport {
  handleRequest: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  sessionId: string | undefined;
  onclose: (() => void) | undefined;
}

interface MockTransportOptions {
  sessionIdGenerator: () => string;
  onsessioninitialized: (sessionId: string) => void;
}

type MockServerResponse = ServerResponse & {
  writeHead: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
};

const transportMockState = vi.hoisted(() => {
  function createTransportMock(): MockTransport {
    return {
      handleRequest: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      sessionId: undefined,
      onclose: undefined,
    };
  }

  return {
    created: [] as MockTransport[],
    options: [] as MockTransportOptions[],
    createTransportMock,
    // eslint-disable-next-line prefer-arrow-callback
    constructor: vi.fn(function StreamableHTTPServerTransport(options: MockTransportOptions) {
      const transport = createTransportMock();

      transportMockState.created.push(transport);
      transportMockState.options.push(options);

      return transport;
    }),
  };
});

const isInitializeRequestMock = vi.hoisted(() =>
  vi.fn((body: unknown) => {
    if (body == null || typeof body !== 'object') return false;

    return 'method' in body && body.method === 'initialize';
  }),
);

vi.mock('@modelcontextprotocol/sdk/server/streamableHttp.js', () => ({
  StreamableHTTPServerTransport: transportMockState.constructor,
}));

vi.mock('@modelcontextprotocol/sdk/types.js', () => ({
  isInitializeRequest: isInitializeRequestMock,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a fake StreamableHTTPServerTransport with spies for request handling and close. */
function createMockTransport() {
  return transportMockState.createTransportMock();
}

/** Build a fake MCP session with spies for `connect` and client capability lookup. */
function createMockMcpSession() {
  return {
    connect: vi.fn(async () => {}),
    server: {
      oninitialized: undefined as (() => void) | undefined,
      getClientCapabilities: vi.fn(() => ({})),
    },
  };
}

function createMockRequest({
  body,
  headers = {},
  method = 'GET',
  url,
}: {
  body?: string | Record<string, unknown>;
  headers?: IncomingHttpHeaders;
  method?: string;
  url: string;
}) {
  const req = new EventEmitter() as IncomingMessage;

  req.url = url;
  req.method = method;
  req.headers = headers;

  if (method === 'POST') {
    queueMicrotask(() => {
      if (body != null) {
        const rawBody = typeof body === 'string' ? body : JSON.stringify(body);

        req.emit('data', Buffer.from(rawBody));
      }

      req.emit('end');
    });
  }

  return req;
}

function createMockResponse() {
  return {
    writeHead: vi.fn(),
    end: vi.fn(),
  } as unknown as MockServerResponse;
}

type CreateHttpHandlerDeps = Parameters<typeof createHttpHandler>[0];
type HttpTransport = CreateHttpHandlerDeps['transports'] extends Map<string, infer T> ? T : never;

function asHttpTransport(transport: MockTransport) {
  return transport as unknown as HttpTransport;
}

function createDeps() {
  const mcpSession = createMockMcpSession();
  const transports = new Map<string, HttpTransport>();

  return {
    deps: {
      buildMcpSession: vi.fn(
        () => mcpSession as unknown as ReturnType<CreateHttpHandlerDeps['buildMcpSession']>,
      ),
      transports,
      hooksService: { start: vi.fn() } as unknown as CreateHttpHandlerDeps['hooksService'],
      markInitialized: vi.fn(),
      mcpLog: vi.fn(async () => {}),
      PKG_VERSION: '1.2.3-test',
    },
    mcpSession,
    transports,
  };
}

function getJsonResponse(res: MockServerResponse) {
  const [[payload]] = res.end.mock.calls;

  return JSON.parse(String(payload)) as unknown;
}

const initializeRequest = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'test-client', version: '0.0.0' },
  },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createHttpHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    transportMockState.created.length = 0;
    transportMockState.options.length = 0;
    isInitializeRequestMock.mockImplementation((body: unknown) => {
      if (body == null || typeof body !== 'object') return false;

      return 'method' in body && body.method === 'initialize';
    });
  });

  it('responds to GET /health with ok status and package version', async () => {
    const { deps } = createDeps();
    const handler = createHttpHandler(deps);
    const req = createMockRequest({ method: 'GET', url: '/health' });
    const res = createMockResponse();

    await handler(req, res);

    expect(res.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'application/json' });
    expect(getJsonResponse(res)).toEqual({ ok: true, version: '1.2.3-test' });
  });

  it('responds to unknown routes with 404 Not Found', async () => {
    const { deps } = createDeps();
    const handler = createHttpHandler(deps);
    const req = createMockRequest({ method: 'GET', url: '/unknown' });
    const res = createMockResponse();

    await handler(req, res);

    expect(res.writeHead).toHaveBeenCalledWith(404);
    expect(res.end).toHaveBeenCalledWith('Not Found');
  });

  it('creates and connects a transport for a valid MCP initialize request', async () => {
    const { deps, mcpSession, transports } = createDeps();
    const handler = createHttpHandler(deps);
    const req = createMockRequest({ body: initializeRequest, method: 'POST', url: '/mcp' });
    const res = createMockResponse();

    await handler(req, res);

    const [transport] = transportMockState.created;
    const [options] = transportMockState.options;

    expect(transportMockState.constructor).toHaveBeenCalledOnce();
    expect(deps.buildMcpSession).toHaveBeenCalledOnce();
    expect(mcpSession.connect).toHaveBeenCalledWith(transport);
    expect(transport.handleRequest).toHaveBeenCalledWith(req, res, initializeRequest);

    transport.sessionId = 'session-1';
    options.onsessioninitialized('session-1');

    expect(transports.get('session-1')).toBe(asHttpTransport(transport));
  });

  it('reuses an existing transport when mcp-session-id is provided', async () => {
    const { deps, transports } = createDeps();
    const existingTransport = createMockTransport();

    transports.set('existing-session', asHttpTransport(existingTransport));

    const handler = createHttpHandler(deps);
    const req = createMockRequest({
      body: { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      headers: { 'mcp-session-id': 'existing-session' },
      method: 'POST',
      url: '/mcp',
    });
    const res = createMockResponse();

    await handler(req, res);

    expect(existingTransport.handleRequest).toHaveBeenCalledWith(req, res, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
    });
    expect(deps.buildMcpSession).not.toHaveBeenCalled();
    expect(transportMockState.constructor).not.toHaveBeenCalled();
  });

  it('rejects an invalid session ID without an initialize request', async () => {
    const { deps } = createDeps();
    const handler = createHttpHandler(deps);
    const req = createMockRequest({
      body: { jsonrpc: '2.0', id: 3, method: 'tools/list' },
      headers: { 'mcp-session-id': 'missing-session' },
      method: 'POST',
      url: '/mcp',
    });
    const res = createMockResponse();

    await handler(req, res);

    expect(res.writeHead).toHaveBeenCalledWith(400, { 'Content-Type': 'application/json' });
    expect(res.end).toHaveBeenCalledWith(
      JSON.stringify({
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: 'Bad Request: provide mcp-session-id or send an initialize request',
        },
        id: null,
      }),
    );
    expect(deps.buildMcpSession).not.toHaveBeenCalled();
  });

  it('returns a JSON-RPC parse error for malformed JSON request bodies', async () => {
    const { deps } = createDeps();
    const handler = createHttpHandler(deps);
    const req = createMockRequest({ body: '{ bad json', method: 'POST', url: '/mcp' });
    const res = createMockResponse();

    await handler(req, res);

    expect(res.writeHead).toHaveBeenCalledWith(400, { 'Content-Type': 'application/json' });
    expect(getJsonResponse(res)).toEqual({
      jsonrpc: '2.0',
      error: { code: -32700, message: 'Parse error' },
      id: null,
    });
    expect(deps.buildMcpSession).not.toHaveBeenCalled();
  });

  it('rejects GET /mcp without a session as a bad request', async () => {
    const { deps } = createDeps();
    const handler = createHttpHandler(deps);
    const req = createMockRequest({ method: 'GET', url: '/mcp' });
    const res = createMockResponse();

    await handler(req, res);

    expect(res.writeHead).toHaveBeenCalledWith(400, { 'Content-Type': 'application/json' });
    expect(res.end).toHaveBeenCalledWith(
      JSON.stringify({
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: 'Bad Request: provide mcp-session-id or send an initialize request',
        },
        id: null,
      }),
    );
    expect(deps.buildMcpSession).not.toHaveBeenCalled();
  });

  it('removes a stored session when the transport closes', async () => {
    const { deps, transports } = createDeps();
    const handler = createHttpHandler(deps);
    const req = createMockRequest({ body: initializeRequest, method: 'POST', url: '/mcp' });
    const res = createMockResponse();

    await handler(req, res);

    const [transport] = transportMockState.created;
    const [options] = transportMockState.options;

    transport.sessionId = 'session-to-clean';
    options.onsessioninitialized('session-to-clean');

    expect(transports.has('session-to-clean')).toBe(true);

    transport.onclose?.();

    expect(transports.has('session-to-clean')).toBe(false);
  });
});
