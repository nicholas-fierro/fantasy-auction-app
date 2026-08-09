// League Value Model v1 — projects auction prices for an upcoming draft from
// this league's own official-auction history. Pure and unit-testable; the
// CLI runner (scripts/calc-projected-values.ts) feeds it PocketBase data and
// writes the results to player_seasons.projected_auction_value.
//
// Methodology, parameter choices, and the backtest that justified them are
// documented in docs/auction-value-model.md. Change parameters there and in
// DEFAULT_VALUE_MODEL_CONFIG together.

// One historical observation joined to that season's rankings. `price` is the
// paid price for a priced official-auction pick, or 0 for a ranked player who
// went undrafted that year (synthesized so the model learns that most ranked
// QBs/TEs cost nothing). See src/server/lib/value-data.ts for how these are built.
export interface HistoryRow {
  year: number;
  position: string;
  position_rank: number; // that year's FantasyPros position rank (>0)
  rank: number; // that year's overall rank (0 = unknown)
  price: number; // dollars paid, or 0 = went undrafted this year
}

// A player to estimate, carrying the upcoming season's rankings.
export interface ValueTarget {
  key: string; // caller's identifier (e.g. player_seasons record id)
  position: string;
  position_rank: number;
  rank: number;
}

export interface ValueModelConfig {
  // Per-year recency multiplier: a comp from year Y weighs decay^(draftYear - Y).
  decay: number;
  // Total league budget the drafted pool is normalized to (12 teams x $200).
  budget: number;
  // How many players actually get auctioned (12 teams x 7 players).
  draftedPoolSize: number;
  // Comp windows tried in order until minComps comps are found.
  windows: number[];
  minComps: number;
}

export const DEFAULT_VALUE_MODEL_CONFIG: ValueModelConfig = {
  decay: 0.85,
  budget: 2400,
  draftedPoolSize: 84,
  windows: [2, 4, 8],
  minComps: 3,
};

// Positions the league actually bids on. Cross-position overall-rank comps are
// restricted to these; K/DST go in the $0/$1 snake tail and get no estimate.
const AUCTION_POSITIONS = new Set(['QB', 'RB', 'WR', 'TE']);

interface WeightedPrice {
  price: number;
  weight: number;
}

// Weighted quantile: the price at which fraction `q` of the total comp weight
// lies below. Assumes non-empty `comps` (callers guarantee this).
export function weightedQuantile(comps: WeightedPrice[], q: number): number {
  const sorted = [...comps].sort((a, b) => a.price - b.price);
  const target = sorted.reduce((sum, c) => sum + c.weight, 0) * q;
  let cumulative = 0;
  for (const comp of sorted) {
    cumulative += comp.weight;
    if (cumulative >= target) return comp.price;
  }
  return sorted[sorted.length - 1].price;
}

// Weighted median: the price at which half the total comp weight lies below.
// Median (not mean) is the outlier guard — a single wild overpay in a small
// neighborhood moves it barely or not at all.
export function weightedMedian(comps: WeightedPrice[]): number {
  return weightedQuantile(comps, 0.5);
}

// ---------------------------------------------------------------------------
// Comp collection — shared by the offline model and the in-app live estimator
// ---------------------------------------------------------------------------
//
// Both estimates answer "what has this league paid for a player at this slot?"
// over the same comp neighborhood with the same recency decay. They differ
// only in what happens afterwards: `computeAuctionEstimates` normalizes the
// board to the league budget, `src/lib/estimated-value.ts` deliberately does
// not (docs/auction-value-model.md). Keeping one collector is what stops the
// two from drifting apart on windows, minComps, or the cross-position gate.

// Which criterion matched a comp: same position within `window` position-rank
// slots, or a different auction position within `window` of overall rank.
export type CompMatch = 'position' | 'overall';

export interface MatchedComp<R extends HistoryRow> {
  row: R;
  match: CompMatch;
  weight: number; // decay^(draftYear - row.year)
}

export interface CompSet<R extends HistoryRow> {
  comps: MatchedComp<R>[];
  window: number; // the window that produced this comp set
  // Whether `window` reached `config.minComps`. The offline model requires it
  // (a thin neighborhood is not worth writing to the board); the live
  // estimator shows any non-empty set.
  sufficient: boolean;
}

// History bucketed by position for fast same-position lookup, plus the flat
// list for the cross-position overall-rank scan.
export interface CompIndex<R extends HistoryRow> {
  byPosition: Map<string, R[]>;
  all: readonly R[];
}

export function buildCompIndex<R extends HistoryRow>(rows: readonly R[]): CompIndex<R> {
  const byPosition = new Map<string, R[]>();
  for (const row of rows) {
    const bucket = byPosition.get(row.position);
    if (bucket) bucket.push(row);
    else byPosition.set(row.position, [row]);
  }
  return { byPosition, all: rows };
}

// A player to find comps for. `rank` may be 0 (unknown), which skips the
// cross-position criterion entirely.
export type CompTarget = Pick<ValueTarget, 'position' | 'position_rank' | 'rank'>;

// Comps for `target` in `draftYear`: prior-year observations that are EITHER
// (a) same position within ±window position-rank slots, or (b) a different
// auction position within ±window of the target's overall rank — the Nth-ranked
// player overall costs about the same across bid-on positions, since positional
// discounts are already baked into consensus overall rank (validated in the
// backtest, where all-position cross comps beat both RB/WR-only and none).
// Windows are tried in order until `minComps` comps are found.
export function collectComps<R extends HistoryRow>(
  index: CompIndex<R>,
  target: CompTarget,
  draftYear: number,
  config: ValueModelConfig = DEFAULT_VALUE_MODEL_CONFIG
): CompSet<R> {
  const recency = (year: number) => Math.pow(config.decay, draftYear - year);
  // Price 0 rows are kept on purpose — they are ranked players who went
  // undrafted, and they pull the median toward $0 for slots this league
  // rarely pays for.
  const usable = (row: R) => row.year < draftYear && row.position_rank > 0 && row.price >= 0;
  const crossEligible = target.rank > 0 && AUCTION_POSITIONS.has(target.position);

  const within = (window: number): MatchedComp<R>[] => {
    const comps: MatchedComp<R>[] = [];
    for (const row of index.byPosition.get(target.position) ?? []) {
      if (usable(row) && Math.abs(row.position_rank - target.position_rank) <= window) {
        comps.push({ row, match: 'position', weight: recency(row.year) });
      }
    }
    if (crossEligible) {
      for (const row of index.all) {
        if (row.position === target.position || !AUCTION_POSITIONS.has(row.position)) continue;
        if (usable(row) && row.rank > 0 && Math.abs(row.rank - target.rank) <= window) {
          comps.push({ row, match: 'overall', weight: recency(row.year) });
        }
      }
    }
    return comps;
  };

  let comps: MatchedComp<R>[] = [];
  let window = config.windows[config.windows.length - 1];
  for (const candidate of config.windows) {
    window = candidate;
    comps = within(candidate);
    if (comps.length >= config.minComps) return { comps, window, sufficient: true };
  }
  return { comps, window, sufficient: false };
}

export function toWeightedPrices<R extends HistoryRow>(
  comps: readonly MatchedComp<R>[]
): WeightedPrice[] {
  return comps.map((comp) => ({ price: comp.row.price, weight: comp.weight }));
}

// Raw (pre-normalization) estimate: recency-weighted median of the comp
// neighborhood, or null when even the widest window finds fewer than
// `minComps` comps (deep players the league has never paid for, K/DST).
function rawEstimate(
  index: CompIndex<HistoryRow>,
  target: ValueTarget,
  draftYear: number,
  config: ValueModelConfig
): number | null {
  const { comps, sufficient } = collectComps(index, target, draftYear, config);
  return sufficient ? weightedMedian(toWeightedPrices(comps)) : null;
}

// Estimate every target and normalize so the top `draftedPoolSize` estimates
// sum to `budget` — comp medians recall past prices, but each draft always
// spends the full budget, so the whole board is scaled to it. Targets with no
// comps get 0. Returned values are rounded whole dollars keyed by target.key.
export function computeAuctionEstimates(
  history: HistoryRow[],
  targets: ValueTarget[],
  draftYear: number,
  config: ValueModelConfig = DEFAULT_VALUE_MODEL_CONFIG
): Map<string, number> {
  // `collectComps` drops unusable rows (position_rank <= 0, negative price,
  // not a prior year) per lookup; price 0 rows are kept on purpose.
  const index = buildCompIndex(history);

  const raw = new Map<string, number>();
  for (const target of targets) {
    if (target.position_rank <= 0) continue;
    const estimate = rawEstimate(index, target, draftYear, config);
    if (estimate !== null) raw.set(target.key, estimate);
  }

  const pool = [...raw.values()].sort((a, b) => b - a).slice(0, config.draftedPoolSize);
  const poolTotal = pool.reduce((sum, v) => sum + v, 0);
  const scale = poolTotal > 0 ? config.budget / poolTotal : 1;

  const estimates = new Map<string, number>();
  for (const target of targets) {
    const value = raw.get(target.key);
    estimates.set(target.key, value == null ? 0 : Math.round(value * scale));
  }
  return estimates;
}
