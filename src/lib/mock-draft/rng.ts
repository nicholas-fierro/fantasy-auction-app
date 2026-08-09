// Seeded, deterministic randomness for the mock draft. Every stochastic decision
// derives its RNG from the auction id plus a decision key that encodes the exact
// context (pick order, team, player). Consequences:
//   - A new mock auction (new id) plays out differently every time.
//   - Within one auction, a page refresh recomputes identical hidden maxes and
//     nominations — the draft is resume-safe with no transient state persisted.

// FNV-1a string hash → 32-bit unsigned int seed.
export function hashString(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// mulberry32 PRNG: returns a function producing floats in [0, 1). Fast, tiny,
// good enough distribution for gameplay jitter (not cryptographic).
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A seeded generator for a decision within an auction.
export function seededRandom(auctionId: string, decisionKey: string): () => number {
  return mulberry32(hashString(`${auctionId}:${decisionKey}`));
}

// A single deterministic float in [0, 1) for a decision.
export function seededUnit(auctionId: string, decisionKey: string): number {
  return seededRandom(auctionId, decisionKey)();
}

// A deterministic float in [min, max) for a decision.
export function seededUniform(
  auctionId: string,
  decisionKey: string,
  min: number,
  max: number
): number {
  return min + seededUnit(auctionId, decisionKey) * (max - min);
}

// A deterministic standard-normal draw for a decision (Box-Muller over the first
// two outputs of the seeded generator). Uniform jitter is fine for a small nudge,
// but market noise wants a bell: most players near their comp value, a few well
// off it. Guarded against log(0), which the generator can return.
export function seededNormal(auctionId: string, decisionKey: string): number {
  const rng = seededRandom(auctionId, decisionKey);
  const u1 = Math.max(rng(), Number.EPSILON);
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

// Weighted sample from `items` using `weights` (same length, non-negative), using
// the given [0,1) draw. Falls back to the highest-weight item if total weight is
// 0. Pure — the caller supplies the random draw so seeding stays centralized.
export function weightedPick<T>(items: T[], weights: number[], draw: number): T {
  const total = weights.reduce((sum, w) => sum + Math.max(0, w), 0);
  if (total <= 0) {
    // No usable weights — return the first item (caller guarantees non-empty).
    return items[0];
  }
  let target = draw * total;
  for (let i = 0; i < items.length; i++) {
    target -= Math.max(0, weights[i]);
    if (target <= 0) return items[i];
  }
  return items[items.length - 1];
}
