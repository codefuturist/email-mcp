export interface ClosableSession {
  close(): Promise<void> | void;
}

interface SessionEntry<T extends ClosableSession> {
  transport: T;
  lastAccess: number;
  activeRequests: number;
}

interface SessionRegistryOptions {
  idleTtlMs: number;
  maxSessions: number;
  now?: () => number;
}

/**
 * Bounds long-lived Streamable HTTP sessions without interrupting active requests.
 * Idle sessions are expired by TTL; when capacity is reached, the least-recently
 * used inactive session is evicted before accepting a new one.
 */
export default class SessionRegistry<T extends ClosableSession> {
  private readonly sessions = new Map<string, SessionEntry<T>>();

  private readonly idleTtlMs: number;

  private readonly maxSessions: number;

  private readonly now: () => number;

  constructor(options: SessionRegistryOptions) {
    if (!Number.isFinite(options.idleTtlMs) || options.idleTtlMs <= 0) {
      throw new Error('idleTtlMs must be a positive number');
    }
    if (!Number.isInteger(options.maxSessions) || options.maxSessions <= 0) {
      throw new Error('maxSessions must be a positive integer');
    }

    this.idleTtlMs = options.idleTtlMs;
    this.maxSessions = options.maxSessions;
    this.now = options.now ?? Date.now;
  }

  get size(): number {
    return this.sessions.size;
  }

  acquire(sessionId: string): T | undefined {
    const entry = this.sessions.get(sessionId);
    if (!entry) return undefined;

    entry.activeRequests += 1;
    entry.lastAccess = this.now();
    return entry.transport;
  }

  add(sessionId: string, transport: T, activeRequests = 0): void {
    this.sessions.set(sessionId, {
      transport,
      lastAccess: this.now(),
      activeRequests,
    });
  }

  release(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;

    entry.activeRequests = Math.max(0, entry.activeRequests - 1);
    entry.lastAccess = this.now();
  }

  remove(sessionId: string, transport?: T): boolean {
    const entry = this.sessions.get(sessionId);
    if (!entry || (transport && entry.transport !== transport)) return false;
    return this.sessions.delete(sessionId);
  }

  async pruneIdle(): Promise<number> {
    const cutoff = this.now() - this.idleTtlMs;
    const expired = [...this.sessions.entries()]
      .filter(([, entry]) => entry.activeRequests === 0 && entry.lastAccess <= cutoff)
      .map(([sessionId]) => sessionId);

    await Promise.allSettled(expired.map(async (sessionId) => this.closeSession(sessionId)));
    return expired.length;
  }

  async ensureCapacity(): Promise<boolean> {
    await this.pruneIdle();
    if (this.sessions.size < this.maxSessions) return true;

    const candidates = [...this.sessions.entries()]
      .filter(([, entry]) => entry.activeRequests === 0)
      .sort((a, b) => a[1].lastAccess - b[1].lastAccess);

    for (const [sessionId] of candidates) {
      if (this.sessions.size < this.maxSessions) break;
      await this.closeSession(sessionId);
    }

    return this.sessions.size < this.maxSessions;
  }

  async closeAll(): Promise<void> {
    const sessionIds = [...this.sessions.keys()];
    await Promise.allSettled(sessionIds.map(async (sessionId) => this.closeSession(sessionId, true)));
  }

  private async closeSession(sessionId: string, includeActive = false): Promise<boolean> {
    const entry = this.sessions.get(sessionId);
    if (!entry || (!includeActive && entry.activeRequests > 0)) return false;

    this.sessions.delete(sessionId);
    await entry.transport.close();
    return true;
  }
}
