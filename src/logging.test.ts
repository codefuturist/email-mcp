import { __resetForTesting, bindServer, markInitialized, mcpLog } from './logging.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a fake McpServer with spies for `isConnected` and `sendLoggingMessage`. */
function createMockServer(connected = true) {
  return {
    isConnected: vi.fn(() => connected),
    sendLoggingMessage: vi.fn(async () => {}),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('mcpLog', () => {
  beforeEach(() => {
    __resetForTesting();
  });

  it('drops messages when no server is bound', async () => {
    // No bindServer() called — should not throw
    await expect(mcpLog('info', 'test', 'hello')).resolves.toBeUndefined();
  });

  it('drops messages before markInitialized() is called', async () => {
    const mock = createMockServer(true);
    bindServer(mock as never);

    await mcpLog('info', 'test', 'should be dropped');

    expect(mock.sendLoggingMessage).not.toHaveBeenCalled();
  });

  it('forwards messages after markInitialized() when connected', async () => {
    const mock = createMockServer(true);
    bindServer(mock as never);
    markInitialized();

    await mcpLog('info', 'server', 'Email MCP server started');

    expect(mock.sendLoggingMessage).toHaveBeenCalledOnce();
    expect(mock.sendLoggingMessage).toHaveBeenCalledWith({
      level: 'info',
      logger: 'server',
      data: 'Email MCP server started',
    });
  });

  it('drops messages when transport is not connected', async () => {
    const mock = createMockServer(false); // not connected
    bindServer(mock as never);
    markInitialized();

    await mcpLog('warning', 'test', 'no transport');

    expect(mock.sendLoggingMessage).not.toHaveBeenCalled();
  });

  it('swallows errors from sendLoggingMessage', async () => {
    const mock = createMockServer(true);
    mock.sendLoggingMessage = vi.fn(async () => {
      throw new Error('transport closed');
    });
    bindServer(mock as never);
    markInitialized();

    // Should resolve without throwing
    await expect(mcpLog('error', 'test', 'boom')).resolves.toBeUndefined();
  });
});
