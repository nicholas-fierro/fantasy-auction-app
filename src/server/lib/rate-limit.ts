// In-memory fixed-window rate limiter keyed by an arbitrary string.
//
// ponytail: per-instance memory — buckets live in this Node process only and do
// NOT share across serverless instances/regions, so the effective limit is
// (configured limit x instance count) and all counters reset on redeploy. That
// is acceptable for the single-instance production target (docs/PRODUCTION_
// OWNERSHIP.md). Upgrade path if the app ever scales horizontally: back this
// same signature with a shared store (a PocketBase collection, or Redis/Upstash).

interface Window {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Window>();

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number; // 0 when allowed
}

// Records an attempt against `key` and reports whether it is within `max` per
// `windowMs`. `now` is injectable for deterministic tests.
export function rateLimit(
  key: string,
  max: number,
  windowMs: number,
  now: number = Date.now(),
): RateLimitResult {
  const w = buckets.get(key);
  if (!w || now >= w.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, retryAfterSeconds: 0 };
  }
  if (w.count >= max) {
    return { allowed: false, retryAfterSeconds: Math.ceil((w.resetAt - now) / 1000) };
  }
  w.count += 1;
  return { allowed: true, retryAfterSeconds: 0 };
}

// Best-effort client IP from the standard forwarded headers. x-forwarded-for is
// a comma-separated list (client, proxy1, ...) — the first entry is the client.
export function clientIp(headers: Headers): string {
  const forwarded = headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0].trim();
  return headers.get('x-real-ip')?.trim() || 'unknown';
}
