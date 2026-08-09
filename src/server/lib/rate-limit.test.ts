import { describe, it, expect } from 'vitest';
import { rateLimit, clientIp } from './rate-limit';

describe('rateLimit', () => {
  it('enforces the limit and resets after the window', () => {
    const key = `test-${Math.random()}`;
    const max = 3;
    const win = 1000;

    // First `max` attempts allowed within the window.
    expect(rateLimit(key, max, win, 0).allowed).toBe(true);
    expect(rateLimit(key, max, win, 100).allowed).toBe(true);
    expect(rateLimit(key, max, win, 200).allowed).toBe(true);

    // Over budget: denied with a positive retry-after.
    const denied = rateLimit(key, max, win, 300);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSeconds).toBeGreaterThan(0);

    // New window: allowed again.
    expect(rateLimit(key, max, win, 1000).allowed).toBe(true);
  });

  it('takes the first entry of x-forwarded-for', () => {
    expect(clientIp(new Headers({ 'x-forwarded-for': '1.2.3.4, 5.6.7.8' }))).toBe('1.2.3.4');
    expect(clientIp(new Headers())).toBe('unknown');
  });
});
