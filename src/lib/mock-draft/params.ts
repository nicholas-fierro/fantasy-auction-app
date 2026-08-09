// The tunable constants of the mock-draft engine, in one place.
//
// Every value here started life as a hand-picked number inside pricing.ts,
// profiles.ts, nomination.ts or snake-ai.ts. Nobody ever fitted them against the
// league's own drafts, which is what `scripts/fit-mock-draft-params.ts` is for.
// `DEFAULT_PARAMS` reproduces those original numbers EXACTLY — if a unit test that
// pins a WTP value starts failing, a default drifted, the test is not wrong.
//
// The fitted values live in params.json so a fit shows up as a readable git diff.
// An empty `params` object there is the fallback path, not an error.
//
// These are read as an explicit trailing argument, never as a mutable global: the
// fitter evaluates many candidate vectors in one process, and a global would break
// both determinism and the test suite.

import file from './params.json';

export interface MockDraftParams {
  // --- profiles.ts ---
  // Blend weight toward the league average: blended = (n/(n+K))*observed + rest.
  // Larger K makes every manager look more like the league mean.
  shrinkK: number;

  // --- pricing.ts ---
  // Per-team multiplicative noise on WTP, uniform on [jitterMin, jitterMax].
  // Kept as an interval rather than a standard deviation so the defaults are exact
  // binary values; the likelihood fit works in log space, where a uniform of
  // half-width h has sd h/sqrt(3).
  jitterMin: number;
  jitterMax: number;
  // Per-team ceiling on WTP as a multiple of the league value, uniform on
  // [ceilMin, ceilMax]. For an elite player the factor stack is almost always
  // above this ceiling, so these two are the only lever on top-of-board prices.
  ceilMin: number;
  ceilMax: number;
  // Need multiplier for a tier-1/2 player who fills an open dedicated starter.
  // Drives the stars-and-scrubs shape.
  needElite: number;
  // Need multiplier for a depth buy that is still inside the position's budget.
  // The already-over-budget case scales with it (see NEED_DEPTH_* in pricing.ts).
  needDepth: number;
  // How hard the positional budget bites: factor = remainingPosBudget * slack / base.
  posBudgetSlack: number;
  // Scales the measured rank-dependent premium the league pays over the model
  // value (see `marketNoiseMean` in pricing.ts). 1 applies the measurement as
  // observed; 0 restores the old assumption that the room pays the model value on
  // average and misses symmetrically.
  marketMeanScale: number;
  // Hard ceiling on any single price, as a share of the league budget. Nobody in
  // this room goes past it however much they like the player. 0 disables it.
  //
  // Measured: 1 of 672 priced picks in 2018-2025 ever cleared above $91 (a $94 in
  // 2020), and the last three drafts topped out at $82-$87. 91/200 = 0.455.
  maxPriceShare: number;

  // --- nomination.ts ---
  // Probability of a drain nomination (throw out a player the team does not want).
  drainProbability: number;
  // How many top-value available players enter the nomination consideration set.
  candidatePool: number;

  // --- snake-ai.ts ---
  // Candidate count a league-average manager samples its snake pick from, before
  // the per-manager reach index scales it.
  snakeTopN: number;
}

// The constants exactly as the engine shipped with them.
export const DEFAULT_PARAMS: MockDraftParams = {
  shrinkK: 8,
  jitterMin: 0.85,
  jitterMax: 1.15,
  ceilMin: 0.98,
  ceilMax: 1.12,
  needElite: 1.25,
  needDepth: 0.55,
  posBudgetSlack: 1.4,
  marketMeanScale: 1,
  maxPriceShare: 0.455,
  drainProbability: 0.35,
  candidatePool: 30,
  snakeTopN: 3,
};

export const PARAMS: MockDraftParams = {
  ...DEFAULT_PARAMS,
  ...((file.params ?? {}) as Partial<MockDraftParams>),
};
