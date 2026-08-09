// Scores simulated drafts against the real draft they are imitating.
//
// Pure: no PocketBase, no fs, no clock. Everything arrives as arguments so the
// metrics can be unit-tested against a synthetic two-team draft.
//
// THE INTERSECTION RULE. The sim buys a different set of players than the real
// draft did, so a player-by-player price comparison is only defined on the
// overlap. Two consequences, both deliberate:
//   - Price metrics run on the intersection only, and every one of them ships
//     with its coverage. A player the sim never bought is NEVER scored as $0 —
//     that would silently blend a selection error into a price error and make the
//     number unreadable.
//   - Because the intersection is biased toward the players both sides agree are
//     worth buying (the easy ones), `sortedCurve` exists as a coverage-free
//     companion: sort both drafts' 84 prices and compare position by position.
//     That is the metric that catches a squashed price distribution.
//
// WHY CORRELATION, NOT JUST MAE. A positional-share MAE can look excellent while
// every manager sits on the league mean — which is exactly what a large shrinkage
// constant produces, and exactly the complaint this work exists to answer. The
// cross-manager Pearson correlation is what separates "close on average" from
// "tells these managers apart".

import type { DraftPickWithDetails } from '@/server/types/draft-pick';
import type { FantasyTeam } from '@/server/types/fantasy-team';
import type { Player } from '@/server/types/player';

export const SCORE_POSITIONS = ['QB', 'RB', 'WR', 'TE'] as const;
export const SNAKE_POSITIONS = ['QB', 'RB', 'WR', 'TE', 'K', 'DST'] as const;

// Same buckets the historical noise measurement uses, so the tables line up.
export const BUCKETS: [number, number, string][] = [
  [1, 6, '1-6'],
  [7, 12, '7-12'],
  [13, 24, '13-24'],
  [25, 48, '25-48'],
  [49, 84, '49-84'],
  [85, 9999, '85+'],
];

export function bucketOf(rank: number): string {
  return BUCKETS.find(([lo, hi]) => rank >= lo && rank <= hi)?.[2] ?? '85+';
}

export interface ScoredPick {
  teamId: string;
  playerId: string;
  price: number; // 0 marks a snake pick
  position: string;
  rank: number;
}

export interface BucketScore {
  label: string;
  n: number; // intersection size, summed over seeds
  coverage: number; // share of the bucket's real picks the sim also bought
  mae: number;
  medianAe: number;
  signedError: number; // sim minus actual; this is what a parameter can move
  relativeAe: number;
}

export interface Scorecard {
  year: number;
  seeds: number;
  // --- selection ---
  coverage: number; // |A ∩ S| / |A| over the priced picks, mean over seeds
  // --- assignment ---
  softAssign: number; // P(sim put this player on his real team), misses count 0
  softAssignConditional: number; // ...over the seeds that bought him at all
  // --- prices ---
  buckets: BucketScore[];
  priceMae: number; // count-weighted over the buckets
  priceSignedError: number;
  sortedCurveMae: number; // coverage-free: sorted price curves, position by position
  crps: number; // proper scoring rule — see computeCrps
  crpsSpreadTerm: number; // the reward half of CRPS: mean |x_i - x_j| across seeds
  // --- per-manager shape ---
  posShareMae: number;
  posShareCorr: number; // mean over positions of the cross-manager correlation
  concentrationMae: number;
  concentrationCorr: number;
  // --- draft level ---
  topPrice: number;
  medianPrice: number;
  over50: number;
  gini: number;
  deepestRank: number;
  leaguePosDollarShare: Record<string, number>;
  // --- snake ---
  snakePosShareMae: number;
  snakePosShareCorr: number;
  snakeSoftAssign: number;
  snakeRosterL1: number; // mean per-team L1 distance between position count vectors
}

// --- small statistics --------------------------------------------------------

export function mean(v: number[]): number {
  return v.length === 0 ? 0 : v.reduce((a, b) => a + b, 0) / v.length;
}

export function median(v: number[]): number {
  if (v.length === 0) return 0;
  const s = [...v].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// Pearson correlation. Returns 0 when either side is constant — with 12 managers
// that means "this metric cannot tell them apart", which is the honest reading.
export function pearson(xs: number[], ys: number[]): number {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return 0;
  const mx = mean(xs.slice(0, n));
  const my = mean(ys.slice(0, n));
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    const a = xs[i] - mx;
    const b = ys[i] - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  if (dx <= 0 || dy <= 0) return 0;
  return num / Math.sqrt(dx * dy);
}

// Empirical CRPS for one player: the sim's price distribution across seeds scored
// against the single price the league actually paid.
//
//   CRPS = mean|x_i - y|  -  (1/2) * mean|x_i - x_j|
//
// This exists because MAE is the wrong objective for a stochastic price, and
// optimizing it actively breaks the sim. MAE against a single realisation is
// minimised at the conditional MEDIAN, so every dollar of spread the sim produces
// costs MAE — a fitter told to minimise MAE will squeeze the price distribution
// toward a point mass and delete the overpays, which are real and which the league
// produces constantly (49.5% of picks at ranks 49-84 go for over 1.25x model
// value). CRPS is a proper scoring rule: the second term pays the forecast back
// for spread, so it is minimised when the sim's price DISTRIBUTION matches the
// real one, not when its centre matches a single draw.
export function computeCrps(samples: number[], observed: number): { crps: number; spread: number } {
  const n = samples.length;
  if (n === 0) return { crps: 0, spread: 0 };
  const accuracy = mean(samples.map((x) => Math.abs(x - observed)));
  let pairSum = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) pairSum += Math.abs(samples[i] - samples[j]);
  }
  const spread = pairSum / (n * n);
  return { crps: accuracy - spread / 2, spread };
}

// Gini over a price vector: 0 = every pick costs the same, 1 = one pick took it all.
export function gini(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const total = s.reduce((a, b) => a + b, 0);
  if (total <= 0) return 0;
  let weighted = 0;
  for (let i = 0; i < s.length; i++) weighted += (i + 1) * s[i];
  return (2 * weighted) / (s.length * total) - (s.length + 1) / s.length;
}

// --- shape helpers -----------------------------------------------------------

// Share of a team's auction dollars spent at each position.
function posShareByTeam(
  picks: ScoredPick[],
  teams: FantasyTeam[]
): Map<string, Record<string, number>> {
  const out = new Map<string, Record<string, number>>();
  for (const team of teams) {
    const mine = picks.filter((p) => p.teamId === team.id && p.price > 0);
    const total = mine.reduce((a, b) => a + b.price, 0);
    const shares: Record<string, number> = {};
    for (const pos of SCORE_POSITIONS) {
      const spent = mine.filter((p) => p.position === pos).reduce((a, b) => a + b.price, 0);
      shares[pos] = total > 0 ? spent / total : 0;
    }
    out.set(team.id, shares);
  }
  return out;
}

// Share of a team's auction dollars in its two most expensive buys.
function concentrationByTeam(picks: ScoredPick[], teams: FantasyTeam[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const team of teams) {
    const prices = picks
      .filter((p) => p.teamId === team.id && p.price > 0)
      .map((p) => p.price)
      .sort((a, b) => b - a);
    const total = prices.reduce((a, b) => a + b, 0);
    const topTwo = (prices[0] ?? 0) + (prices[1] ?? 0);
    out.set(team.id, total > 0 ? topTwo / total : 0);
  }
  return out;
}

// Count of rostered players per position, all phases.
function countsByTeam(picks: ScoredPick[], teams: FantasyTeam[]): Map<string, Record<string, number>> {
  const out = new Map<string, Record<string, number>>();
  for (const team of teams) {
    const counts: Record<string, number> = {};
    for (const pos of SNAKE_POSITIONS) counts[pos] = 0;
    for (const pick of picks) {
      if (pick.teamId !== team.id) continue;
      counts[pick.position] = (counts[pick.position] ?? 0) + 1;
    }
    out.set(team.id, counts);
  }
  return out;
}

// MAE and cross-manager correlation between an actual and a simulated share table.
function shapeError(
  actual: Map<string, Record<string, number>>,
  simulated: Map<string, Record<string, number>>,
  teams: FantasyTeam[],
  positions: readonly string[]
): { mae: number; corr: number } {
  const errors: number[] = [];
  const correlations: number[] = [];
  for (const pos of positions) {
    const xs: number[] = [];
    const ys: number[] = [];
    for (const team of teams) {
      const a = actual.get(team.id)?.[pos] ?? 0;
      const s = simulated.get(team.id)?.[pos] ?? 0;
      errors.push(Math.abs(s - a));
      xs.push(a);
      ys.push(s);
    }
    correlations.push(pearson(xs, ys));
  }
  return { mae: mean(errors), corr: mean(correlations) };
}

// --- the scorer --------------------------------------------------------------

export function toScoredPicks(picks: DraftPickWithDetails[], board: Player[]): ScoredPick[] {
  const rankById = new Map(board.map((p) => [p.id, p.rank ?? 0]));
  return picks.map((pick) => ({
    teamId: pick.fantasy_team_id,
    playerId: pick.player_id,
    price: pick.price ?? 0,
    position: pick.player.position,
    rank: rankById.get(pick.player_id) ?? pick.player.rank ?? 0,
  }));
}

export function scoreDraft(
  actual: ScoredPick[],
  runs: ScoredPick[][],
  teams: FantasyTeam[],
  year: number
): Scorecard {
  const seeds = runs.length;
  const actualPriced = actual.filter((p) => p.price > 0);
  const actualSnake = actual.filter((p) => p.price === 0);
  const actualByPlayer = new Map(actualPriced.map((p) => [p.playerId, p]));
  // One index per run: the assignment loops below are 84 real picks x every seed,
  // and a linear scan of 192 sim picks inside that is what makes the fitter slow.
  const runIndex = runs.map((run) => new Map(run.map((p) => [p.playerId, p])));

  // --- selection and assignment ---
  const coverages: number[] = [];
  const soft: number[] = [];
  const softConditional: number[] = [];
  for (const pick of actualPriced) {
    let bought = 0;
    let matched = 0;
    for (const index of runIndex) {
      const simPick = index.get(pick.playerId);
      if (!simPick || simPick.price <= 0) continue;
      bought++;
      if (simPick.teamId === pick.teamId) matched++;
    }
    soft.push(seeds > 0 ? matched / seeds : 0);
    if (bought > 0) softConditional.push(matched / bought);
  }
  for (const run of runs) {
    const priced = run.filter((p) => p.price > 0);
    const hits = priced.filter((p) => actualByPlayer.has(p.playerId)).length;
    coverages.push(actualPriced.length > 0 ? hits / actualPriced.length : 0);
  }

  // --- prices, on the intersection only ---
  const perBucket = new Map<string, { errs: number[]; signed: number[]; rel: number[] }>();
  const bucketActualCount = new Map<string, number>();
  for (const pick of actualPriced) {
    const label = bucketOf(pick.rank);
    bucketActualCount.set(label, (bucketActualCount.get(label) ?? 0) + seeds);
  }
  for (const run of runs) {
    for (const simPick of run) {
      if (simPick.price <= 0) continue;
      const real = actualByPlayer.get(simPick.playerId);
      if (!real) continue; // selection difference, not a price error
      const label = bucketOf(real.rank);
      const entry = perBucket.get(label) ?? { errs: [], signed: [], rel: [] };
      entry.errs.push(Math.abs(simPick.price - real.price));
      entry.signed.push(simPick.price - real.price);
      entry.rel.push(real.price > 0 ? Math.abs(simPick.price - real.price) / real.price : 0);
      perBucket.set(label, entry);
    }
  }
  const buckets: BucketScore[] = [];
  for (const [, , label] of BUCKETS) {
    const entry = perBucket.get(label);
    if (!entry || entry.errs.length === 0) continue;
    buckets.push({
      label,
      n: entry.errs.length,
      coverage: entry.errs.length / (bucketActualCount.get(label) || 1),
      mae: mean(entry.errs),
      medianAe: median(entry.errs),
      signedError: mean(entry.signed),
      relativeAe: mean(entry.rel),
    });
  }
  const totalN = buckets.reduce((a, b) => a + b.n, 0);
  const priceMae = totalN > 0 ? buckets.reduce((a, b) => a + b.mae * b.n, 0) / totalN : 0;
  const priceSignedError =
    totalN > 0 ? buckets.reduce((a, b) => a + b.signedError * b.n, 0) / totalN : 0;

  // --- CRPS, per real pick, over the seeds that bought him ---
  // A player the sim never buys contributes nothing, exactly as with the price MAE:
  // that is a selection miss, and `coverage` above is where it belongs.
  const crpsValues: number[] = [];
  const spreadValues: number[] = [];
  for (const pick of actualPriced) {
    const samples: number[] = [];
    for (const index of runIndex) {
      const simPick = index.get(pick.playerId);
      if (simPick && simPick.price > 0) samples.push(simPick.price);
    }
    if (samples.length < 2) continue;
    const { crps, spread } = computeCrps(samples, pick.price);
    crpsValues.push(crps);
    spreadValues.push(spread);
  }

  // --- the coverage-free price curve ---
  const actualCurve = actualPriced.map((p) => p.price).sort((a, b) => b - a);
  const curveErrors: number[] = [];
  for (const run of runs) {
    const simCurve = run
      .filter((p) => p.price > 0)
      .map((p) => p.price)
      .sort((a, b) => b - a);
    for (let i = 0; i < Math.min(actualCurve.length, simCurve.length); i++) {
      curveErrors.push(Math.abs(simCurve[i] - actualCurve[i]));
    }
  }

  // --- per-manager shape, averaged over seeds ---
  const actualShares = posShareByTeam(actual, teams);
  const actualConcentration = concentrationByTeam(actual, teams);
  const actualCounts = countsByTeam(actual, teams);
  const actualSnakeShares = posShareOfCounts(countsByTeam(actualSnake, teams), teams);

  const shapeRuns = runs.map((run) => ({
    shares: posShareByTeam(run, teams),
    concentration: concentrationByTeam(run, teams),
    counts: countsByTeam(run, teams),
    snakeShares: posShareOfCounts(
      countsByTeam(
        run.filter((p) => p.price === 0),
        teams
      ),
      teams
    ),
  }));

  const meanShares = averageShareTables(
    shapeRuns.map((r) => r.shares),
    teams,
    SCORE_POSITIONS
  );
  const meanSnakeShares = averageShareTables(
    shapeRuns.map((r) => r.snakeShares),
    teams,
    SNAKE_POSITIONS
  );
  const meanConcentration = new Map(
    teams.map((t) => [t.id, mean(shapeRuns.map((r) => r.concentration.get(t.id) ?? 0))])
  );

  const posShape = shapeError(actualShares, meanShares, teams, SCORE_POSITIONS);
  const snakeShape = shapeError(actualSnakeShares, meanSnakeShares, teams, SNAKE_POSITIONS);

  const concentrationErrors = teams.map((t) =>
    Math.abs((meanConcentration.get(t.id) ?? 0) - (actualConcentration.get(t.id) ?? 0))
  );
  const concentrationCorr = pearson(
    teams.map((t) => actualConcentration.get(t.id) ?? 0),
    teams.map((t) => meanConcentration.get(t.id) ?? 0)
  );

  // --- draft level, averaged over seeds ---
  const topPrices: number[] = [];
  const medianPrices: number[] = [];
  const over50s: number[] = [];
  const ginis: number[] = [];
  const deepest: number[] = [];
  const posDollars: Record<string, number[]> = { QB: [], RB: [], WR: [], TE: [] };
  for (const run of runs) {
    const prices = run.filter((p) => p.price > 0).map((p) => p.price);
    if (prices.length === 0) continue;
    topPrices.push(Math.max(...prices));
    medianPrices.push(median(prices));
    over50s.push(prices.filter((p) => p > 50).length);
    ginis.push(gini(prices));
    deepest.push(Math.max(...run.filter((p) => p.price > 0).map((p) => p.rank)));
    const total = prices.reduce((a, b) => a + b, 0);
    for (const pos of SCORE_POSITIONS) {
      const spent = run
        .filter((p) => p.price > 0 && p.position === pos)
        .reduce((a, b) => a + b.price, 0);
      posDollars[pos].push(total > 0 ? spent / total : 0);
    }
  }

  // --- snake ---
  const snakeSoft: number[] = [];
  for (const pick of actualSnake) {
    let matched = 0;
    for (const index of runIndex) {
      const simPick = index.get(pick.playerId);
      if (simPick && simPick.price === 0 && simPick.teamId === pick.teamId) matched++;
    }
    snakeSoft.push(seeds > 0 ? matched / seeds : 0);
  }
  const rosterL1: number[] = [];
  for (const run of shapeRuns) {
    for (const team of teams) {
      const a = actualCounts.get(team.id) ?? {};
      const s = run.counts.get(team.id) ?? {};
      rosterL1.push(
        SNAKE_POSITIONS.reduce((sum, pos) => sum + Math.abs((s[pos] ?? 0) - (a[pos] ?? 0)), 0)
      );
    }
  }

  return {
    year,
    seeds,
    coverage: mean(coverages),
    softAssign: mean(soft),
    softAssignConditional: mean(softConditional),
    buckets,
    priceMae,
    priceSignedError,
    sortedCurveMae: mean(curveErrors),
    crps: mean(crpsValues),
    crpsSpreadTerm: mean(spreadValues),
    posShareMae: posShape.mae,
    posShareCorr: posShape.corr,
    concentrationMae: mean(concentrationErrors),
    concentrationCorr,
    topPrice: mean(topPrices),
    medianPrice: mean(medianPrices),
    over50: mean(over50s),
    gini: mean(ginis),
    deepestRank: mean(deepest),
    leaguePosDollarShare: Object.fromEntries(
      SCORE_POSITIONS.map((pos) => [pos, mean(posDollars[pos])])
    ),
    snakePosShareMae: snakeShape.mae,
    snakePosShareCorr: snakeShape.corr,
    snakeSoftAssign: mean(snakeSoft),
    snakeRosterL1: mean(rosterL1),
  };
}

// Counts to shares, so snake picks (which have no price) get the same treatment.
function posShareOfCounts(
  counts: Map<string, Record<string, number>>,
  teams: FantasyTeam[]
): Map<string, Record<string, number>> {
  const out = new Map<string, Record<string, number>>();
  for (const team of teams) {
    const row = counts.get(team.id) ?? {};
    const total = SNAKE_POSITIONS.reduce((a, pos) => a + (row[pos] ?? 0), 0);
    const shares: Record<string, number> = {};
    for (const pos of SNAKE_POSITIONS) shares[pos] = total > 0 ? (row[pos] ?? 0) / total : 0;
    out.set(team.id, shares);
  }
  return out;
}

function averageShareTables(
  tables: Map<string, Record<string, number>>[],
  teams: FantasyTeam[],
  positions: readonly string[]
): Map<string, Record<string, number>> {
  const out = new Map<string, Record<string, number>>();
  for (const team of teams) {
    const row: Record<string, number> = {};
    for (const pos of positions) {
      row[pos] = mean(tables.map((t) => t.get(team.id)?.[pos] ?? 0));
    }
    out.set(team.id, row);
  }
  return out;
}

// --- the composite objective -------------------------------------------------

// Every term is divided by the same term in the null arm, so the terms are
// dimensionless and L = 1 reads as "no better than doing nothing". That is the
// only weighting that needs no hand-tuning; the half weights say only that the
// draft-level and snake terms are secondary to the stated complaint.
export function compositeObjective(
  cards: Scorecard[],
  nulls: Scorecard[],
  noiseFloorMae: number
): number {
  const ratio = (get: (c: Scorecard) => number): number => {
    const a = mean(cards.map(get));
    const b = mean(nulls.map(get));
    return b > 0 ? a / b : a > 0 ? 2 : 1;
  };

  const chance = 1 / 12;
  const missRate = 1 - mean(cards.map((c) => c.softAssign));
  const nullMissRate = 1 - chance;

  const priceTerm = noiseFloorMae > 0 ? mean(cards.map((c) => c.priceMae)) / noiseFloorMae : 0;
  const draftLevelZ = mean(
    cards.map((c, i) => {
      const n = nulls[i] ?? nulls[0];
      if (!n) return 0;
      const rel = (x: number, y: number) => (y > 0 ? Math.abs(x - y) / y : 0);
      return (
        rel(c.topPrice, n.topPrice) + rel(c.medianPrice, n.medianPrice) + rel(c.gini, n.gini)
      );
    })
  );

  return (
    1.0 * ratio((c) => c.posShareMae) +
    1.0 * (missRate / nullMissRate) +
    1.0 * priceTerm +
    0.5 * draftLevelZ +
    0.5 * ratio((c) => c.snakePosShareMae)
  );
}
