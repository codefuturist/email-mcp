import { mcpLog } from './logging.js';

// ---------------------------------------------------------------------------
// mcpLog now writes structured lines to stderr (MCP 2026-07-28 deprecated the
// server→client logging channel, SEP-2577). These tests pin the stderr sink.
// ---------------------------------------------------------------------------

describe('mcpLog', () => {
  let writes: string[];
  let spy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    writes = [];
    spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    spy.mockRestore();
  });

  it('writes a formatted line to stderr and resolves undefined', async () => {
    await expect(mcpLog('info', 'server', 'Email MCP server started')).resolves.toBeUndefined();
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain('INFO');
    expect(writes[0]).toContain('[server]');
    expect(writes[0]).toContain('Email MCP server started');
    expect(writes[0].endsWith('\n')).toBe(true);
  });

  it('uppercases the level and tags the logger', async () => {
    await mcpLog('warning', 'hooks', 'rate limit reached');
    expect(writes[0]).toMatch(/\bWARNING\b/);
    expect(writes[0]).toContain('[hooks]');
  });

  it('JSON-stringifies non-string data', async () => {
    await mcpLog('debug', 'test', { count: 3, ok: true });
    expect(writes[0]).toContain('{"count":3,"ok":true}');
  });

  it('never throws on circular data', async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await expect(mcpLog('error', 'test', circular)).resolves.toBeUndefined();
    expect(writes).toHaveLength(1);
  });
});
