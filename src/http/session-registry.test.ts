import { describe, expect, it, vi } from 'vitest';

import SessionRegistry from './session-registry.js';

function transport() {
  return { close: vi.fn(async () => undefined) };
}

describe('SessionRegistry', () => {
  it('expires idle sessions but preserves active requests', async () => {
    let now = 1_000;
    const registry = new SessionRegistry({ idleTtlMs: 100, maxSessions: 4, now: () => now });
    const idle = transport();
    const active = transport();

    registry.add('idle', idle);
    registry.add('active', active);
    expect(registry.acquire('active')).toBe(active);

    now = 1_101;
    expect(await registry.pruneIdle()).toBe(1);
    expect(idle.close).toHaveBeenCalledOnce();
    expect(active.close).not.toHaveBeenCalled();
    expect(registry.size).toBe(1);

    registry.release('active');
    now = 1_202;
    expect(await registry.pruneIdle()).toBe(1);
    expect(active.close).toHaveBeenCalledOnce();
    expect(registry.size).toBe(0);
  });

  it('evicts the least-recently used inactive session at capacity', async () => {
    let now = 1_000;
    const registry = new SessionRegistry({ idleTtlMs: 10_000, maxSessions: 2, now: () => now });
    const oldest = transport();
    const newest = transport();

    registry.add('oldest', oldest);
    now = 1_010;
    registry.add('newest', newest);

    expect(await registry.ensureCapacity()).toBe(true);
    expect(oldest.close).toHaveBeenCalledOnce();
    expect(newest.close).not.toHaveBeenCalled();
    expect(registry.size).toBe(1);
  });

  it('refuses new capacity rather than closing active sessions', async () => {
    const registry = new SessionRegistry({ idleTtlMs: 10_000, maxSessions: 1 });
    const active = transport();

    registry.add('active', active);
    registry.acquire('active');

    expect(await registry.ensureCapacity()).toBe(false);
    expect(active.close).not.toHaveBeenCalled();
    expect(registry.size).toBe(1);
  });

  it('does not let a late close callback remove a replacement session', () => {
    const registry = new SessionRegistry({ idleTtlMs: 10_000, maxSessions: 2 });
    const first = transport();
    const replacement = transport();

    registry.add('same-id', first);
    registry.add('same-id', replacement);

    expect(registry.remove('same-id', first)).toBe(false);
    expect(registry.size).toBe(1);
    expect(registry.acquire('same-id')).toBe(replacement);
  });
});
