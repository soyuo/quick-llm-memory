import { describe, expect, it } from 'vitest';
import { HttpRateLimiter } from '../src/mcp/rate-limiter.js';

describe('HTTP rate limiter', () => {
  it('limits each client to its fixed window and expires old windows', () => {
    let now = 0;
    const limiter = new HttpRateLimiter(2, 1_000, 2, () => now);
    expect(limiter.allow('a')).toBe(true);
    expect(limiter.allow('a')).toBe(true);
    expect(limiter.allow('a')).toBe(false);
    expect(limiter.allow('b')).toBe(true);
    expect(limiter.allow('c')).toBe(true);
    expect(limiter.size).toBeLessThanOrEqual(2);
    now = 1_000;
    expect(limiter.allow('a')).toBe(true);
  });
});
