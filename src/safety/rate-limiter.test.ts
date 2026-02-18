import RateLimiter from './rate-limiter.js';

describe('RateLimiter', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows sends up to the configured limit', () => {
    const limiter = new RateLimiter(3);
    expect(limiter.tryConsume('acct')).toBe(true);
    expect(limiter.tryConsume('acct')).toBe(true);
    expect(limiter.tryConsume('acct')).toBe(true);
  });

  it('rejects sends after limit is exhausted', () => {
    const limiter = new RateLimiter(3);
    limiter.tryConsume('acct');
    limiter.tryConsume('acct');
    limiter.tryConsume('acct');
    expect(limiter.tryConsume('acct')).toBe(false);
  });

  it('tracks accounts independently', () => {
    const limiter = new RateLimiter(1);
    expect(limiter.tryConsume('a')).toBe(true);
    expect(limiter.tryConsume('a')).toBe(false);
    expect(limiter.tryConsume('b')).toBe(true);
  });

  it('remaining() returns max for unknown accounts', () => {
    const limiter = new RateLimiter(5);
    expect(limiter.remaining('unknown')).toBe(5);
  });

  it('remaining() decreases after consumption', () => {
    const limiter = new RateLimiter(5);
    limiter.tryConsume('acct');
    limiter.tryConsume('acct');
    expect(limiter.remaining('acct')).toBe(3);
  });

  it('refills tokens after the time window elapses', () => {
    vi.useFakeTimers();
    const limiter = new RateLimiter(2);
    limiter.tryConsume('acct');
    limiter.tryConsume('acct');
    expect(limiter.tryConsume('acct')).toBe(false);

    vi.advanceTimersByTime(60_000);

    expect(limiter.tryConsume('acct')).toBe(true);
  });

  it('uses default limit of 10 when no argument provided', () => {
    const limiter = new RateLimiter();
    expect(limiter.remaining('any')).toBe(10);
    for (let i = 0; i < 10; i++) {
      expect(limiter.tryConsume('any')).toBe(true);
    }
    expect(limiter.tryConsume('any')).toBe(false);
  });
});
