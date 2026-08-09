// Usage-signal model — does prior-season usage predict which cheap auction buys
// return starter-level points? See docs/auction-research-plan.md (Workstream 1).
//
// Everything here is pure so the vitest suite can cover it; all PocketBase I/O
// and reporting lives in scripts/backtest-usage-signal.ts.
//
// The one modelling rule worth stating up front: the cohort is ~350 rows over 10
// features, so this deliberately uses L2-regularized logistic regression rather
// than anything flexible. A gradient-boosted model on this sample would fit noise
// and report it confidently.

export interface RawStats {
  targets?: number;
  receptions?: number;
  receiving_yards?: number;
  receiving_tds?: number;
  carries?: number;
  rushing_yards?: number;
  rushing_tds?: number;
  fantasy_points?: number;
  fantasy_points_ppr?: number;
  // From scripts/import-nflverse-snap-counts.ts. Absent on any game log
  // imported before that script existed, so every consumer must tolerate null.
  offense_snaps?: number | null;
  offense_pct?: number | null;
}

export interface GameLogRow {
  player_id: string;
  season: number;
  week: number;
  team: string;
  stats: RawStats;
}

// The league plays half PPR. PPR = standard + 1/reception, so the midpoint of the
// two nflverse columns is exactly half PPR without re-deriving every scoring rule.
export function halfPpr(stats: RawStats): number {
  return ((stats.fantasy_points ?? 0) + (stats.fantasy_points_ppr ?? 0)) / 2;
}

// Fantasy regular season. 2018-2020 ran 17 NFL weeks, 2021+ run 18; weeks 1-17
// is the common window and matches how the league actually plays.
export const FANTASY_WEEKS = 17;
// "Late season" for the last8_* features — a role won in November is only
// partially priced into the following August's rankings.
export const LATE_SEASON_FIRST_WEEK = 10;

const key = (...parts: (string | number)[]) => parts.join('|');

export function seasonPoints(logs: readonly GameLogRow[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const log of logs) {
    if (log.week > FANTASY_WEEKS) continue;
    const k = key(log.player_id, log.season);
    out.set(k, (out.get(k) ?? 0) + halfPpr(log.stats));
  }
  return out;
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Replacement baseline: the season total of the median weekly score among players
 * who went for $0 in that year's auction — literally what the league got for free
 * in the snake rounds. Taking the median week by week (rather than the median of
 * season totals) keeps a pool member's bye or injury from dragging the whole line
 * down, and matches how a manager actually fills the slot each week.
 *
 * Returns a map of `${season}|${position}` -> season-total baseline points.
 */
export function replacementBaselines(
  logs: readonly GameLogRow[],
  freePicksBySeason: ReadonlyMap<number, readonly string[]>,
  positionOf: ReadonlyMap<string, string>
): Map<string, number> {
  const weekly = new Map<string, number>();
  for (const log of logs) {
    if (log.week > FANTASY_WEEKS) continue;
    weekly.set(key(log.player_id, log.season, log.week), halfPpr(log.stats));
  }

  const out = new Map<string, number>();
  for (const [season, playerIds] of freePicksBySeason) {
    const byPosition = new Map<string, string[]>();
    for (const id of playerIds) {
      const position = positionOf.get(id);
      if (!position) continue;
      const bucket = byPosition.get(position);
      if (bucket) bucket.push(id);
      else byPosition.set(position, [id]);
    }
    for (const [position, ids] of byPosition) {
      let total = 0;
      for (let week = 1; week <= FANTASY_WEEKS; week++) {
        // A pool member with no log that week scored 0 — that is the real
        // experience of starting a replacement player on his bye.
        total += median(ids.map((id) => weekly.get(key(id, season, week)) ?? 0));
      }
      out.set(key(season, position), total);
    }
  }
  return out;
}

export interface UsageFeatures {
  games_played: number;
  targets_pg: number;
  target_share: number;
  carries_pg: number;
  carry_share: number;
  rec_per_carry: number;
  yards_per_touch: number;
  td_rate: number;
  last8_target_share: number;
  last8_carry_share: number;
  // Snap-derived. Zero when the season has no imported snap data at all, which
  // is indistinguishable from a player who never took a snap — so only run the
  // snap arms over seasons the snap importer has covered.
  snap_pct: number;
  last8_snap_pct: number;
  snap_pct_trend: number;
  opportunity_per_snap: number;
  games_50pct_snaps: number;
}

/** The touch-based features from the original negative result (PR #89). */
export const FEATURE_NAMES: readonly (keyof UsageFeatures)[] = [
  'games_played',
  'targets_pg',
  'target_share',
  'carries_pg',
  'carry_share',
  'rec_per_carry',
  'yards_per_touch',
  'td_rate',
  'last8_target_share',
  'last8_carry_share',
];

/** What snap counts add: opportunity, including opportunity that produced nothing. */
export const SNAP_FEATURE_NAMES: readonly (keyof UsageFeatures)[] = [
  'snap_pct',
  'last8_snap_pct',
  'snap_pct_trend',
  'opportunity_per_snap',
  'games_50pct_snaps',
];

const safeDiv = (numerator: number, denominator: number) =>
  denominator > 0 ? numerator / denominator : 0;

/**
 * Per-player usage for one season, built only from that season's logs — callers
 * pass season Y−1 so nothing leaks from the season being predicted.
 *
 * Shares use the team's totals *in the games the player actually played*, so a
 * player who missed half a year isn't credited with a share of games he sat out.
 */
export function buildUsageFeatures(logs: readonly GameLogRow[]): Map<string, UsageFeatures> {
  const inWindow = logs.filter((log) => log.week <= FANTASY_WEEKS);

  const teamTargets = new Map<string, number>();
  const teamCarries = new Map<string, number>();
  for (const log of inWindow) {
    const k = key(log.season, log.team, log.week);
    teamTargets.set(k, (teamTargets.get(k) ?? 0) + (log.stats.targets ?? 0));
    teamCarries.set(k, (teamCarries.get(k) ?? 0) + (log.stats.carries ?? 0));
  }

  interface Accumulator {
    games: number;
    targets: number;
    carries: number;
    receptions: number;
    yards: number;
    tds: number;
    teamTargets: number;
    teamCarries: number;
    lateTargets: number;
    lateCarries: number;
    lateTeamTargets: number;
    lateTeamCarries: number;
    snaps: number;
    /** Targets + carries from the same games `snaps` counts, so the ratio matches. */
    snapOpportunities: number;
    snapGames: number;
    snapPctTotal: number;
    lateSnapGames: number;
    lateSnapPctTotal: number;
    games50pct: number;
  }
  const acc = new Map<string, Accumulator>();
  const blank = (): Accumulator => ({
    games: 0,
    targets: 0,
    carries: 0,
    receptions: 0,
    yards: 0,
    tds: 0,
    teamTargets: 0,
    teamCarries: 0,
    lateTargets: 0,
    lateCarries: 0,
    lateTeamTargets: 0,
    lateTeamCarries: 0,
    snaps: 0,
    snapOpportunities: 0,
    snapGames: 0,
    snapPctTotal: 0,
    lateSnapGames: 0,
    lateSnapPctTotal: 0,
    games50pct: 0,
  });

  for (const log of inWindow) {
    let entry = acc.get(log.player_id);
    if (!entry) {
      entry = blank();
      acc.set(log.player_id, entry);
    }
    const gameKey = key(log.season, log.team, log.week);
    const tTargets = teamTargets.get(gameKey) ?? 0;
    const tCarries = teamCarries.get(gameKey) ?? 0;

    entry.games += 1;
    entry.targets += log.stats.targets ?? 0;
    entry.carries += log.stats.carries ?? 0;
    entry.receptions += log.stats.receptions ?? 0;
    entry.yards += (log.stats.receiving_yards ?? 0) + (log.stats.rushing_yards ?? 0);
    entry.tds += (log.stats.receiving_tds ?? 0) + (log.stats.rushing_tds ?? 0);
    entry.teamTargets += tTargets;
    entry.teamCarries += tCarries;

    // Snap percentages average over the games that actually have snap data, so
    // a partially-imported season shrinks the denominator instead of silently
    // reporting every missing game as a zero-snap game.
    const snapPct = log.stats.offense_pct;
    if (snapPct !== null && snapPct !== undefined) {
      entry.snaps += log.stats.offense_snaps ?? 0;
      // Numerator and denominator must span the same games. Counting every
      // game's touches against only the snap-covered games' snaps would inflate
      // opportunity_per_snap on a partially imported season.
      entry.snapOpportunities += (log.stats.targets ?? 0) + (log.stats.carries ?? 0);
      entry.snapGames += 1;
      entry.snapPctTotal += snapPct;
      if (snapPct >= 0.5) entry.games50pct += 1;
    }

    if (log.week >= LATE_SEASON_FIRST_WEEK) {
      entry.lateTargets += log.stats.targets ?? 0;
      entry.lateCarries += log.stats.carries ?? 0;
      entry.lateTeamTargets += tTargets;
      entry.lateTeamCarries += tCarries;
      if (snapPct !== null && snapPct !== undefined) {
        entry.lateSnapGames += 1;
        entry.lateSnapPctTotal += snapPct;
      }
    }
  }

  const out = new Map<string, UsageFeatures>();
  for (const [playerId, entry] of acc) {
    const touches = entry.carries + entry.receptions;
    const snapPct = safeDiv(entry.snapPctTotal, entry.snapGames);
    const lateSnapPct = safeDiv(entry.lateSnapPctTotal, entry.lateSnapGames);
    out.set(playerId, {
      games_played: entry.games,
      targets_pg: safeDiv(entry.targets, entry.games),
      target_share: safeDiv(entry.targets, entry.teamTargets),
      carries_pg: safeDiv(entry.carries, entry.games),
      carry_share: safeDiv(entry.carries, entry.teamCarries),
      rec_per_carry: safeDiv(entry.receptions, entry.carries),
      yards_per_touch: safeDiv(entry.yards, touches),
      td_rate: safeDiv(entry.tds, touches),
      last8_target_share: safeDiv(entry.lateTargets, entry.lateTeamTargets),
      last8_carry_share: safeDiv(entry.lateCarries, entry.lateTeamCarries),
      snap_pct: snapPct,
      last8_snap_pct: lateSnapPct,
      // Zero, not negative, when there is no late-season snap data to compare.
      snap_pct_trend: entry.lateSnapGames > 0 ? lateSnapPct - snapPct : 0,
      opportunity_per_snap: safeDiv(entry.snapOpportunities, entry.snaps),
      games_50pct_snaps: entry.games50pct,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

function averageRanks(values: readonly number[]): number[] {
  const order = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value);
  const ranks = new Array<number>(values.length);
  for (let i = 0; i < order.length; ) {
    let j = i;
    while (j + 1 < order.length && order[j + 1].value === order[i].value) j++;
    const shared = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[order[k].index] = shared;
    i = j + 1;
  }
  return ranks;
}

export function spearman(xs: readonly number[], ys: readonly number[]): number {
  if (xs.length !== ys.length || xs.length < 3) return 0;
  const rx = averageRanks(xs);
  const ry = averageRanks(ys);
  const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
  const mx = mean(rx);
  const my = mean(ry);
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < rx.length; i++) {
    num += (rx[i] - mx) * (ry[i] - my);
    dx += (rx[i] - mx) ** 2;
    dy += (ry[i] - my) ** 2;
  }
  const den = Math.sqrt(dx * dy);
  return den === 0 ? 0 : num / den;
}

/**
 * Area under the ROC curve, via the Mann-Whitney identity (mean rank of the
 * positives). Returns NaN when a fold has only one class, which is the honest
 * answer — AUC is undefined there and must not be averaged in as 0.5.
 */
export function auc(scores: readonly number[], labels: readonly number[]): number {
  const positives = labels.reduce((sum, label) => sum + (label === 1 ? 1 : 0), 0);
  const negatives = labels.length - positives;
  if (positives === 0 || negatives === 0) return NaN;
  const ranks = averageRanks(scores);
  let rankSum = 0;
  for (let i = 0; i < labels.length; i++) if (labels[i] === 1) rankSum += ranks[i];
  return (rankSum - (positives * (positives + 1)) / 2) / (positives * negatives);
}

export interface Standardizer {
  means: number[];
  sds: number[];
}

export function fitStandardizer(rows: readonly number[][]): Standardizer {
  const width = rows[0]?.length ?? 0;
  const means = new Array<number>(width).fill(0);
  const sds = new Array<number>(width).fill(1);
  for (let j = 0; j < width; j++) {
    const column = rows.map((row) => row[j]);
    const mean = column.reduce((a, b) => a + b, 0) / column.length;
    const variance = column.reduce((sum, v) => sum + (v - mean) ** 2, 0) / column.length;
    means[j] = mean;
    // A constant column carries no information; dividing by 1 leaves it at 0.
    sds[j] = variance > 1e-12 ? Math.sqrt(variance) : 1;
  }
  return { means, sds };
}

export function applyStandardizer(rows: readonly number[][], std: Standardizer): number[][] {
  return rows.map((row) => row.map((value, j) => (value - std.means[j]) / std.sds[j]));
}

export interface LogisticModel {
  weights: number[];
  intercept: number;
}

export interface LogisticOptions {
  learningRate?: number;
  iterations?: number;
  l2?: number;
}

const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));

/** Batch gradient descent. Inputs are expected pre-standardized. */
export function fitLogistic(
  rows: readonly number[][],
  labels: readonly number[],
  options: LogisticOptions = {}
): LogisticModel {
  const { learningRate = 0.1, iterations = 3000, l2 = 1 } = options;
  const width = rows[0]?.length ?? 0;
  const weights = new Array<number>(width).fill(0);
  let intercept = 0;
  const n = rows.length || 1;

  for (let step = 0; step < iterations; step++) {
    const gradW = new Array<number>(width).fill(0);
    let gradB = 0;
    for (let i = 0; i < rows.length; i++) {
      let z = intercept;
      for (let j = 0; j < width; j++) z += weights[j] * rows[i][j];
      const error = sigmoid(z) - labels[i];
      for (let j = 0; j < width; j++) gradW[j] += error * rows[i][j];
      gradB += error;
    }
    for (let j = 0; j < width; j++) {
      weights[j] -= learningRate * (gradW[j] / n + (l2 * weights[j]) / n);
    }
    intercept -= learningRate * (gradB / n);
  }
  return { weights, intercept };
}

export function predictLogistic(model: LogisticModel, rows: readonly number[][]): number[] {
  return rows.map((row) => {
    let z = model.intercept;
    for (let j = 0; j < row.length; j++) z += model.weights[j] * row[j];
    return sigmoid(z);
  });
}

export interface CohortRow {
  year: number;
  playerId: string;
  name: string;
  position: string;
  price: number;
  positionRank: number;
  features: UsageFeatures;
  /** Age in years at the September 1 kickoff of `year`. Callers impute misses. */
  age: number;
  points: number;
  surplus: number;
  hit: 0 | 1;
}

export interface FoldResult {
  year: number;
  n: number;
  positives: number;
  auc: number;
}

export interface BacktestResult {
  folds: FoldResult[];
  meanAuc: number;
  // Coefficients from a fit over the whole cohort — for interpretation only,
  // never for scoring the same rows they were fit on.
  fullFitWeights: { feature: string; weight: number }[];
}

/**
 * Leave-one-season-out backtest. Standardizer and model are refit inside every
 * fold on the training years only, so nothing about the held-out season — not
 * even its feature means — informs its own prediction.
 */
export function leaveOneSeasonOut(
  cohort: readonly CohortRow[],
  extract: (row: CohortRow) => number[],
  options?: LogisticOptions,
  featureNames: readonly string[] = FEATURE_NAMES
): BacktestResult {
  const years = [...new Set(cohort.map((row) => row.year))].sort((a, b) => a - b);
  const folds: FoldResult[] = [];

  for (const year of years) {
    const train = cohort.filter((row) => row.year !== year);
    const test = cohort.filter((row) => row.year === year);
    if (train.length === 0 || test.length === 0) continue;

    const std = fitStandardizer(train.map(extract));
    const model = fitLogistic(
      applyStandardizer(train.map(extract), std),
      train.map((row) => row.hit),
      options
    );
    const scores = predictLogistic(model, applyStandardizer(test.map(extract), std));
    folds.push({
      year,
      n: test.length,
      positives: test.reduce((sum, row) => sum + row.hit, 0),
      auc: auc(scores, test.map((row) => row.hit)),
    });
  }

  const scored = folds.filter((fold) => Number.isFinite(fold.auc));
  const meanAuc = scored.length
    ? scored.reduce((sum, fold) => sum + fold.auc, 0) / scored.length
    : NaN;

  const std = fitStandardizer(cohort.map(extract));
  const model = fitLogistic(
    applyStandardizer(cohort.map(extract), std),
    cohort.map((row) => row.hit),
    options
  );
  const width = model.weights.length;
  const names = width === featureNames.length ? featureNames : featureNames.slice(0, width);

  return {
    folds,
    meanAuc,
    fullFitWeights: model.weights.map((weight, j) => ({
      feature: String(names[j] ?? `x${j}`),
      weight,
    })),
  };
}

export function featureVector(row: CohortRow): number[] {
  return FEATURE_NAMES.map((name) => row.features[name]);
}

const DAYS_PER_YEAR = 365.2425;

/**
 * Age in years at that season's September 1 kickoff, fractional so two players
 * born ten months apart are not rounded onto the same integer. Returns null for
 * a missing or unparseable birth date; callers impute rather than passing 0,
 * which would land far outside the real range and skew standardization.
 */
export function ageAtSeason(birthDate: string | null | undefined, year: number): number | null {
  const trimmed = (birthDate ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return null;
  const born = Date.parse(`${trimmed}T00:00:00Z`);
  if (!Number.isFinite(born)) return null;
  const age = (Date.UTC(year, 8, 1) - born) / (DAYS_PER_YEAR * 24 * 60 * 60 * 1000);
  return age > 0 && age < 60 ? age : null;
}

// --- Arms ------------------------------------------------------------------
// Four feature sets, all scored through the same leave-one-season-out harness so
// the numbers are directly comparable to the 0.514 the touch arm produced.

/** Age enters as a curve: production peaks and then falls off, it doesn't trend. */
export const SNAP_AGE_FEATURE_NAMES: readonly string[] = [
  ...SNAP_FEATURE_NAMES,
  'age',
  'age_squared',
];

export function snapAgeVector(row: CohortRow): number[] {
  return [...SNAP_FEATURE_NAMES.map((name) => row.features[name]), row.age, row.age ** 2];
}

export const ALL_FEATURE_NAMES: readonly string[] = [...FEATURE_NAMES, ...SNAP_AGE_FEATURE_NAMES];

export function usageSnapAgeVector(row: CohortRow): number[] {
  return [...featureVector(row), ...snapAgeVector(row)];
}

/**
 * The only arm that would change a draft board: the two things already known to
 * carry signal (price 0.617, rank 0.608) plus the new data. Rank is negated so
 * higher is better, matching how the rank-alone null is scored.
 */
export const PRICED_SNAP_AGE_FEATURE_NAMES: readonly string[] = [
  'price',
  'neg_position_rank',
  ...SNAP_AGE_FEATURE_NAMES,
];

export function pricedSnapAgeVector(row: CohortRow): number[] {
  return [row.price, -row.positionRank, ...snapAgeVector(row)];
}
