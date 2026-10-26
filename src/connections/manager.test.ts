import eventBus from '../services/event-bus.js';
import type { AccountConfig } from '../types/index.js';
import ConnectionManager from './manager.js';

const { instances, mockState } = vi.hoisted(() => ({
  instances: [] as { usable: boolean }[],
  // What the fake server "negotiated": toggled per test to simulate a
  // connection that did or did not end up encrypted.
  mockState: { secureConnection: true },
}));

vi.mock('imapflow', () => {
  class MockImapFlow {
    usable = true;
    secureConnection = mockState.secureConnection;
    connect = vi.fn().mockResolvedValue(undefined);
    logout = vi.fn().mockResolvedValue(undefined);
    close = vi.fn();
    private listeners = new Map<string, ((...args: unknown[]) => void)[]>();

    constructor() {
      instances.push(this);
    }

    on(event: string, listener: (...args: unknown[]) => void): this {
      const forEvent = this.listeners.get(event) ?? [];
      forEvent.push(listener);
      this.listeners.set(event, forEvent);
      return this;
    }

    /** Fire a fake ImapFlow event. Mirrors EventEmitter: an unhandled 'error' throws. */
    emit(event: string, ...args: unknown[]): boolean {
      const forEvent = this.listeners.get(event) ?? [];
      forEvent.forEach((listener) => {
        listener(...args);
      });
      if (event === 'error' && forEvent.length === 0) throw args[0];
      return forEvent.length > 0;
    }
  }
  return { ImapFlow: MockImapFlow };
});

vi.mock('../logging.js', () => ({
  mcpLog: vi.fn().mockResolvedValue(undefined),
}));

const account: AccountConfig = {
  name: 'work',
  email: 'me@example.com',
  username: 'me@example.com',
  password: 'secret',
  imap: { host: 'imap.example.com', port: 993, tls: true, starttls: false, verifySsl: true },
  smtp: { host: 'smtp.example.com', port: 465, tls: true, starttls: false, verifySsl: true },
};

describe('ConnectionManager', () => {
  beforeEach(() => {
    instances.length = 0;
    vi.spyOn(eventBus, 'emit');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reuses a usable IMAP client without announcing a reconnect', async () => {
    const manager = new ConnectionManager([account]);

    const first = await manager.getImapClient('work');
    const second = await manager.getImapClient('work');

    expect(second).toBe(first);
    expect(instances).toHaveLength(1);
    expect(eventBus.emit).not.toHaveBeenCalledWith('imap:reconnect', expect.anything());
  });

  it('shares one in-flight IMAP connection across concurrent callers', async () => {
    const manager = new ConnectionManager([account]);
    const clients = await Promise.all(
      Array.from({ length: 8 }, () => manager.getImapClient('work')),
    );
    expect(instances).toHaveLength(1);
    expect(clients.every((client) => client === clients[0])).toBe(true);
  });

  it('clears a failed in-flight attempt so a later caller can retry', async () => {
    mockState.secureConnection = false;
    const manager = new ConnectionManager([
      { ...account, imap: { ...account.imap, tls: false, starttls: true } },
    ]);
    const results = await Promise.allSettled([
      manager.getImapClient('work'),
      manager.getImapClient('work'),
    ]);
    expect(results.every((result) => result.status === 'rejected')).toBe(true);
    expect(instances).toHaveLength(1);
    mockState.secureConnection = true;
    await expect(manager.getImapClient('work')).resolves.toBeDefined();
    expect(instances).toHaveLength(2);
  });

  it('does not leave a connection alive when shutdown races with connect', async () => {
    const manager = new ConnectionManager([account]);
    const attempt = manager.getImapClient('work');
    const rejected = expect(attempt).rejects.toThrow('closing');
    await manager.closeAll();
    await rejected;
    await expect(manager.getImapClient('work')).rejects.toThrow('closing');
    expect(
      (instances[0] as unknown as { close: ReturnType<typeof vi.fn> }).close,
    ).toHaveBeenCalled();
  });

  it('announces a reconnect when it replaces a dead connection', async () => {
    const manager = new ConnectionManager([account]);

    const first = await manager.getImapClient('work');
    // Simulate the socket dying between tool calls.
    (first as unknown as { usable: boolean }).usable = false;

    const second = await manager.getImapClient('work');

    expect(second).not.toBe(first);
    // Anything derived from the old connection — capability probes, cached
    // UIDVALIDITY, label-strategy memos — is now suspect and must be told.
    expect(eventBus.emit).toHaveBeenCalledWith('imap:reconnect', { account: 'work' });
  });
});

// ImapFlow is an EventEmitter. Node's default behaviour for an unhandled
// 'error' event is to throw — on a cached, long-lived connection (an idle
// socket timeout, the server closing the connection) that crashes the whole
// process, not just the one request in flight.
describe('IMAP connection lifecycle', () => {
  beforeEach(() => {
    instances.length = 0;
    vi.spyOn(eventBus, 'emit');
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('absorbs an error event and reconnects on the next request instead of crashing', async () => {
    const manager = new ConnectionManager([account]);
    const first = await manager.getImapClient('work');

    expect(() =>
      (first as unknown as { emit(e: string, ...a: unknown[]): boolean }).emit(
        'error',
        new Error('Socket timeout'),
      ),
    ).not.toThrow();

    const second = await manager.getImapClient('work');
    expect(second).not.toBe(first);
    expect(instances).toHaveLength(2);
    // Same invalidation path as the usable===false case: anything derived
    // from the dead connection is now suspect.
    expect(eventBus.emit).toHaveBeenCalledWith('imap:reconnect', { account: 'work' });
  });

  it('invalidates the cached client on a close event', async () => {
    const manager = new ConnectionManager([account]);
    const first = await manager.getImapClient('work');

    (first as unknown as { emit(e: string, ...a: unknown[]): boolean }).emit('close');

    const second = await manager.getImapClient('work');
    expect(second).not.toBe(first);
  });

  it('does not let a late error from a replaced client invalidate its replacement', async () => {
    const manager = new ConnectionManager([account]);
    type Emits = { emit(e: string, ...a: unknown[]): boolean };
    const first = (await manager.getImapClient('work')) as unknown as Emits;

    (first as Emits).emit('error', new Error('Connection lost'));
    const replacement = await manager.getImapClient('work');

    // The old client's socket finishes tearing down and fires a second,
    // trailing error — it must not evict the healthy client that replaced it.
    (first as Emits).emit('error', new Error('Late stale error from the old socket'));
    const current = await manager.getImapClient('work');

    expect(current).toBe(replacement);
    expect(instances).toHaveLength(2);
  });
});

describe('IMAP STARTTLS enforcement', () => {
  const starttlsAccount: AccountConfig = {
    ...account,
    name: 'starttls',
    imap: { host: 'imap.example.com', port: 143, tls: false, starttls: true, verifySsl: true },
  };

  beforeEach(() => {
    instances.length = 0;
  });
  afterEach(() => {
    mockState.secureConnection = true;
  });

  it('rejects the connection when starttls is required but the session stayed plaintext', async () => {
    mockState.secureConnection = false;
    const manager = new ConnectionManager([starttlsAccount]);

    await expect(manager.getImapClient('starttls')).rejects.toThrow(/STARTTLS/);
  });

  it('accepts the connection when the session was upgraded', async () => {
    mockState.secureConnection = true;
    const manager = new ConnectionManager([starttlsAccount]);

    await expect(manager.getImapClient('starttls')).resolves.toBeDefined();
  });

  it('does not demand upgrade when starttls is off', async () => {
    mockState.secureConnection = false;
    const manager = new ConnectionManager([
      account,
      { ...account, name: 'plainok', imap: { ...account.imap, tls: false, starttls: false } },
    ]);

    await expect(manager.getImapClient('plainok')).resolves.toBeDefined();
  });
});
