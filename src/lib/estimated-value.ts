import { HistoricalValue } from '@/server/types/history';
import {
  DEFAULT_VALUE_MODEL_CONFIG,
  buildCompIndex,
  collectComps,
  toWeightedPrices,
  weightedMedian,
  weightedQuantile,
  type CompIndex,
  type MatchedComp,
} from '@/lib/value-model';

// Pure, unit-testable estimation of a player's auction cost from historical prices.
// The client builds a per-position index once (memoized) and calls `estimateValue`
// per table row.
//
// This is the live "Target Price" — a raw market read. Comp selection and recency
// decay come from the offline League Value Model (src/lib/value-model.ts) that
// fills projected_auction_value — one `collectComps`, so the two cannot drift —
// but the result here is deliberately NOT normalized to the $2400 league budget,
// so they stay independent reference points. Methodology:
// docs/auction-value-model.md.
//
// The other deliberate difference: the model writes nothing when a neighborhood
// is thinner than `minComps`, while these estimators show any non-empty comp set
// rather than leaving a blank cell in the players table.

export type HistoryIndex = CompIndex<HistoricalValue>;
export const buildHistoryIndex = buildCompIndex<HistoricalValue>;

// Median is robust to the occasional overpay outlier that a mean would chase.
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

export interface EstimateResult {
  estimate: number;
  compCount: number;
}

// Comps for a player at `position`/`positionRank` (and, when known, overall
// `rank`) in year `beforeYear` — see `collectComps` in value-model.ts for the
// matching rule, windows, and recency weighting.
export function estimateValue(
  index: HistoryIndex,
  position: string,
  positionRank: number,
  rank: number,
  beforeYear: number
): EstimateResult | null {
  const { comps } = collectComps(index, { position, position_rank: positionRank, rank }, beforeYear);
  if (comps.length === 0) return null;

  return {
    estimate: Math.round(weightedMedian(toWeightedPrices(comps))),
    compCount: comps.length,
  };
}

// One comp row for the modal: the full history row (name, year, price, rank,
// position_rank, position), its recency weight, and which criterion matched it.
export type CompDetail = MatchedComp<HistoricalValue>;

export interface EstimateDetail {
  estimate: number; // weightedQuantile(…, 0.5) — identical to estimateValue's estimate
  p25: number;
  p75: number;
  compCount: number;
  window: number; // the window (see ValueModelConfig.windows) that produced the comp set
  comps: CompDetail[];
}

// Richer sibling of `estimateValue` for the comps modal: same comp set and
// recency weighting, but returns the individual rows (with which criterion
// matched each) plus the p25/p50/p75 of the weighted distribution instead of
// just the median. `estimate` is computed the same way as `estimateValue`'s
// estimate, so the two always agree for identical inputs.
export function estimateCompDetail(
  index: HistoryIndex,
  position: string,
  positionRank: number,
  rank: number,
  beforeYear: number
): EstimateDetail | null {
  const { comps, window } = collectComps(index, { position, position_rank: positionRank, rank }, beforeYear);
  if (comps.length === 0) return null;

  const weightedComps = toWeightedPrices(comps);

  return {
    estimate: Math.round(weightedQuantile(weightedComps, 0.5)),
    p25: Math.round(weightedQuantile(weightedComps, 0.25)),
    p75: Math.round(weightedQuantile(weightedComps, 0.75)),
    compCount: comps.length,
    window,
    comps,
  };
}

export interface RollingMedianPoint {
  x: number;
  median: number;
  compCount: number;
}

// Rolling-median curve for the analysis view's overlay: same window-widening
// rule (DEFAULT_VALUE_MODEL_CONFIG.windows / minComps) as `estimateValue`'s
// position-rank criterion, but
// computed directly across the given rows rather than gated to "prior years" —
// the caller decides which years/positions are in scope (typically one call per
// position, per the current year/position filters). Draws the curve
// `estimateValue` is approximating, one point per distinct `x` (position rank or
// overall rank) present in `rows`. This curve is intentionally position-rank-only
// (it's a per-position analysis line); it does not blend in the cross-position
// overall-rank comps that `estimateValue` additionally considers.
export function computeRollingMedian(
  rows: { x: number; price: number }[]
): RollingMedianPoint[] {
  const xValues = [...new Set(rows.map(row => row.x))].sort((a, b) => a - b);

  const pricesWithin = (center: number, window: number) =>
    rows.filter(row => Math.abs(row.x - center) <= window).map(row => row.price);

  const { windows, minComps } = DEFAULT_VALUE_MODEL_CONFIG;
  return xValues.map(x => {
    let comps: number[] = [];
    for (const window of windows) {
      comps = pricesWithin(x, window);
      if (comps.length >= minComps) break;
    }
    return { x, median: Math.round(median(comps)), compCount: comps.length };
  });
}
