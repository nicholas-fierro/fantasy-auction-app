import { describe, expect, it } from 'vitest';
import {
  DEFAULT_VALUE_MODEL_CONFIG,
  buildCompIndex,
  collectComps,
  computeAuctionEstimates,
  type HistoryRow,
} from '@/lib/value-model';
import { buildHistoryIndex, estimateValue } from '@/lib/estimated-value';
import type { HistoricalValue } from '@/server/types/history';

const row = (over: Partial<HistoryRow>): HistoryRow => ({
  year: 2025,
  position: 'RB',
  position_rank: 1,
  rank: 1,
  price: 50,
  ...over,
});

describe('collectComps', () => {
  it('matches same position within the window and ignores far slots', () => {
    const index = buildCompIndex([
      row({ position_rank: 1, rank: 1, price: 60 }),
      row({ position_rank: 3, rank: 4, price: 40 }),
      row({ position_rank: 40, rank: 90, price: 1 }),
    ]);

    const { comps } = collectComps(index, { position: 'RB', position_rank: 2, rank: 2 }, 2026, {
      ...DEFAULT_VALUE_MODEL_CONFIG,
      windows: [2],
      minComps: 1,
    });

    expect(comps.map((c) => c.row.price).sort((a, b) => a - b)).toEqual([40, 60]);
  });

  it('widens through every configured window, not just the first two', () => {
    // Only comp sits 7 position-rank slots away — reachable at ±8, not ±2/±4.
    const index = buildCompIndex([row({ position_rank: 8, rank: 8, price: 30 })]);
    const target = { position: 'RB', position_rank: 1, rank: 0 };

    expect(collectComps(index, target, 2026, {
      ...DEFAULT_VALUE_MODEL_CONFIG,
      windows: [2, 4],
      minComps: 1,
    }).comps).toHaveLength(0);

    const widened = collectComps(index, target, 2026);
    expect(widened.comps).toHaveLength(1);
    expect(widened.window).toBe(8);
  });

  it('admits a draft-year row only when it is external, never our own', () => {
    const target = { position: 'RB', position_rank: 1, rank: 1 };
    const config = { ...DEFAULT_VALUE_MODEL_CONFIG, windows: [2], minComps: 1 };

    // Our own in-progress draft must not price the draft it is running.
    const ours = buildCompIndex([
      row({ year: 2025, position_rank: 1, rank: 1, price: 50 }),
      row({ year: 2026, position_rank: 1, rank: 1, price: 90 }),
    ]);
    expect(collectComps(ours, target, 2026, config).comps.map((c) => c.row.price)).toEqual([50]);

    // The same row from an outside board is evidence, at a discount.
    const external = buildCompIndex([
      row({ year: 2025, position_rank: 1, rank: 1, price: 50 }),
      row({ year: 2026, position_rank: 1, rank: 1, price: 90, external: true }),
    ]);
    const comps = collectComps(external, target, 2026, config).comps;
    expect(comps.map((c) => c.row.price).sort((a, b) => a - b)).toEqual([50, 90]);
    // decay^0 * externalWeight, not the full same-year weight of 1.
    expect(comps.find((c) => c.row.year === 2026)?.weight).toBe(
      DEFAULT_VALUE_MODEL_CONFIG.externalWeight
    );
  });

  it('externalWeight 0 drops external rows entirely', () => {
    const index = buildCompIndex([
      row({ year: 2025, position_rank: 1, rank: 1, price: 50 }),
      row({ year: 2026, position_rank: 1, rank: 1, price: 90, external: true }),
      row({ year: 2024, position_rank: 1, rank: 1, price: 30, external: true }),
    ]);
    const { comps } = collectComps(index, { position: 'RB', position_rank: 1, rank: 1 }, 2026, {
      ...DEFAULT_VALUE_MODEL_CONFIG,
      windows: [2],
      minComps: 1,
      externalWeight: 0,
    });
    expect(comps.map((c) => c.row.price)).toEqual([50]);
  });

  it('reports sufficient=false when the widest window is still thin', () => {
    const index = buildCompIndex([row({ position_rank: 1, rank: 1, price: 30 })]);
    const { comps, sufficient } = collectComps(
      index,
      { position: 'RB', position_rank: 1, rank: 1 },
      2026
    );
    expect(comps).toHaveLength(1);
    expect(sufficient).toBe(false); // minComps is 3
  });

  it('cross-position comps stay inside the bid-on positions', () => {
    const index = buildCompIndex([
      row({ position: 'WR', position_rank: 30, rank: 20, price: 25 }),
      row({ position: 'DST', position_rank: 1, rank: 20, price: 1 }),
    ]);

    const { comps } = collectComps(index, { position: 'RB', position_rank: 50, rank: 20 }, 2026, {
      ...DEFAULT_VALUE_MODEL_CONFIG,
      windows: [2],
      minComps: 1,
    });

    expect(comps).toHaveLength(1);
    expect(comps[0].row.position).toBe('WR');
    expect(comps[0].match).toBe('overall');
  });

  it('gives a DST no cross-position comps', () => {
    const index = buildCompIndex([row({ position: 'WR', position_rank: 5, rank: 10, price: 40 })]);
    const { comps } = collectComps(index, { position: 'DST', position_rank: 1, rank: 10 }, 2026, {
      ...DEFAULT_VALUE_MODEL_CONFIG,
      windows: [2],
      minComps: 1,
    });
    expect(comps).toEqual([]);
  });

  it('excludes the draft year and later, and unranked rows', () => {
    const index = buildCompIndex([
      row({ year: 2026, price: 99 }),
      row({ year: 2027, price: 99 }),
      row({ position_rank: 0, price: 99 }),
      row({ year: 2024, price: 20 }),
    ]);

    const { comps } = collectComps(index, { position: 'RB', position_rank: 1, rank: 1 }, 2026, {
      ...DEFAULT_VALUE_MODEL_CONFIG,
      windows: [2],
      minComps: 1,
    });

    expect(comps.map((c) => c.row.price)).toEqual([20]);
  });

  it('weights comps by recency decay', () => {
    const index = buildCompIndex([row({ year: 2024, price: 10 })]);
    const { comps } = collectComps(index, { position: 'RB', position_rank: 1, rank: 1 }, 2026, {
      ...DEFAULT_VALUE_MODEL_CONFIG,
      windows: [2],
      minComps: 1,
    });
    expect(comps[0].weight).toBeCloseTo(0.85 ** 2);
  });
});

describe('target price vs projected value', () => {
  // Same comps, same median. The ONLY difference is budget normalization —
  // if this stops holding, the two estimates have drifted apart again.
  const history: HistoricalValue[] = Array.from({ length: 12 }, (_, i) => ({
    year: 2025,
    player_id: `p${i}`,
    name: `Player ${i}`,
    position: 'RB',
    rank: i + 1,
    position_rank: i + 1,
    price: 100 - i * 5,
    source: 'official' as const,
  }));

  it('agrees before normalization and scales the board to the budget', () => {
    const targets = history.map((h) => ({
      key: h.player_id,
      position: h.position,
      position_rank: h.position_rank,
      rank: h.rank,
    }));

    const index = buildHistoryIndex(history);
    const projected = computeAuctionEstimates(history, targets, 2026, {
      ...DEFAULT_VALUE_MODEL_CONFIG,
      budget: 240,
      draftedPoolSize: targets.length,
    });

    const rawTotal = targets.reduce(
      (sum, t) => sum + (estimateValue(index, t.position, t.position_rank, t.rank, 2026)?.estimate ?? 0),
      0
    );
    const projectedTotal = [...projected.values()].reduce((sum, v) => sum + v, 0);

    // Un-normalized target prices do NOT sum to the budget; projected do.
    expect(rawTotal).not.toBe(240);
    expect(projectedTotal).toBeCloseTo(240, -1);

    // …and the two are the same number up to that single scale factor.
    const scale = 240 / rawTotal;
    for (const t of targets) {
      const target = estimateValue(index, t.position, t.position_rank, t.rank, 2026)!.estimate;
      expect(projected.get(t.key)!).toBeCloseTo(target * scale, -1);
    }
  });
});
