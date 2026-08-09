/// <reference path="../pb_data/types.d.ts" />
//
// Login rate limiting for the `users` collection. Login is client-side
// authWithPassword straight to PocketBase, so
// it can't be limited in Next.js — it's enforced here, in the one PB process.
//
// Limit: 10 attempts per 15 minutes, keyed BOTH per client IP and per email.
// Every attempt (success or failure) counts; the block trips before the
// password is verified. In-process fixed-window map — correct here because
// there is a single PocketBase process (unlike the multi-instance Next.js
// surfaces). Counters reset on PB restart.
//
// Event note: `onRecordAuthWithPasswordRequest` is PocketBase 0.29's pre-auth
// hook for password logins (fires before password verification; e.next()
// performs it). If a future PB version renames it, swap to the nearest
// pre-password-auth request hook for the users collection.
//
// Activation: copy this file into ~/Pocketbase/main/pb_hooks/ and restart
// PocketBase (`./pocketbase serve`) — hooks load at startup.

onRecordAuthWithPasswordRequest((e) => {
  const MAX = 10;
  const WINDOW_MS = 15 * 60 * 1000;

  // Fixed-window counters on a process-global registry that persists across
  // requests (the JSVM re-enters this callback per request).
  if (!globalThis.__loginRateBuckets) {
    globalThis.__loginRateBuckets = {};
  }
  const buckets = globalThis.__loginRateBuckets;

  function overLimit(key, now) {
    const w = buckets[key];
    if (!w || now >= w.resetAt) {
      buckets[key] = { count: 1, resetAt: now + WINDOW_MS };
      return false;
    }
    if (w.count >= MAX) return true;
    w.count += 1;
    return false;
  }

  const now = Date.now();
  const ip = e.realIP() || "unknown";
  const email = (e.identity || "").trim().toLowerCase() || "unknown";

  // Check both keys. Evaluate both so each independently records this attempt.
  const ipBlocked = overLimit("ip:" + ip, now);
  const emailBlocked = overLimit("email:" + email, now);
  if (ipBlocked || emailBlocked) {
    throw new TooManyRequestsError("Too many login attempts. Try again in a few minutes.");
  }

  e.next();
}, "users");
