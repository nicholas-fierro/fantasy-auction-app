import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { computeFantasyPoints, type GameLogStats, type ScoringFormat } from './fantasy-scoring';

// The fixture is real `player_game_logs.stats` sampled from the imported
// nflverse data (2018–2025, REG and POST), deliberately weighted toward the
// paths a hand-picked handful of rows would miss: interceptions, all three
// two-point conversion types, fumbles lost, special-teams and fumble-recovery
// TDs, 300+ passing yards, 10+ reception games, negative totals, and zero lines.
//
// Regenerate against a local PocketBase with the game logs imported; see the
// generator invocation in the PR description. Rows are slimmed of zero/null
// keys, which is exactly how scoring must treat absent keys anyway.
interface FixtureRow {
  season: number;
  week: number;
  season_type: string;
  stats: GameLogStats;
}

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(resolve(here, 'fantasy-scoring.fixture.json'), 'utf8'),
) as { offense: FixtureRow[]; kicking: FixtureRow[] };

const label = (row: FixtureRow) => `${row.season} ${row.season_type} wk${row.week}`;
const num = (stats: GameLogStats, key: string) =>
  typeof stats[key] === 'number' ? (stats[key] as number) : 0;

describe('computeFantasyPoints vs. nflverse provider totals', () => {
  it('has a fixture broad enough to be worth trusting', () => {
    expect(fixture.offense.length).toBeGreaterThan(100);
    expect(fixture.kicking.length).toBeGreaterThan(10);
  });

  // AD-25 keeps `fantasy_points` / `fantasy_points_ppr` purely as validation
  // references. This is that validation: standard and full PPR must reproduce
  // the provider exactly, which pins every yardage, TD, turnover and two-point
  // coefficient. Half-PPR then differs from them only by the reception rate.
  it.each(fixture.offense.map((row) => [label(row), row] as const))(
    'matches provider standard and PPR totals — %s',
    (_name, row) => {
      expect(computeFantasyPoints(row.stats, 'std')).toBeCloseTo(num(row.stats, 'fantasy_points'), 2);
      expect(computeFantasyPoints(row.stats, 'ppr')).toBeCloseTo(
        num(row.stats, 'fantasy_points_ppr'),
        2,
      );
    },
  );

  it('places half-PPR exactly midway between standard and PPR', () => {
    for (const row of fixture.offense) {
      const std = computeFantasyPoints(row.stats, 'std');
      const half = computeFantasyPoints(row.stats, 'half');
      const ppr = computeFantasyPoints(row.stats, 'ppr');
      expect(half).toBeCloseTo((std + ppr) / 2, 2);
      // The whole point of the setting: the three formats only diverge when the
      // player actually caught something.
      if (num(row.stats, 'receptions') === 0) expect(half).toBeCloseTo(std, 2);
      else expect(half).toBeGreaterThan(std);
    }
  });
});

describe('kicking', () => {
  // nflverse's fantasy_points column is offense-only — it reports 0 for a kicker
  // who went 2-for-2 with two PATs — so there is no provider oracle here and
  // these rows are excluded from the cross-check above. Assert the distance
  // ladder against the buckets directly instead.
  it('scores real kicker rows off the distance buckets, not the provider column', () => {
    for (const row of fixture.kicking) {
      const s = row.stats;
      const expected =
        (num(s, 'fg_made_0_19') + num(s, 'fg_made_20_29') + num(s, 'fg_made_30_39')) * 3 +
        num(s, 'fg_made_40_49') * 4 +
        (num(s, 'fg_made_50_59') + num(s, 'fg_made_60_')) * 5 +
        num(s, 'pat_made') -
        num(s, 'fg_missed');
      // Kickers accrue no offensive stats, so kicking is the whole total.
      expect(computeFantasyPoints(s, 'half')).toBeCloseTo(expected, 2);
      // Reception multiplier must not touch a kicker's score.
      expect(computeFantasyPoints(s, 'std')).toBeCloseTo(computeFantasyPoints(s, 'ppr'), 2);
    }
  });

  it('applies the distance ladder and penalises misses', () => {
    const madeFrom = (bucket: string) => computeFantasyPoints({ [bucket]: 1 }, 'std');
    expect(madeFrom('fg_made_0_19')).toBe(3);
    expect(madeFrom('fg_made_20_29')).toBe(3);
    expect(madeFrom('fg_made_30_39')).toBe(3);
    expect(madeFrom('fg_made_40_49')).toBe(4);
    expect(madeFrom('fg_made_50_59')).toBe(5);
    expect(madeFrom('fg_made_60_')).toBe(5);
    expect(computeFantasyPoints({ pat_made: 3 }, 'std')).toBe(3);
    expect(computeFantasyPoints({ fg_made_40_49: 1, fg_missed: 2 }, 'std')).toBe(2);
  });
});

describe('edge cases', () => {
  it('treats an empty or all-null row as zero rather than NaN', () => {
    for (const format of ['std', 'half', 'ppr'] as ScoringFormat[]) {
      expect(computeFantasyPoints({}, format)).toBe(0);
      expect(computeFantasyPoints({ passing_yards: null, receptions: null }, format)).toBe(0);
      // fg_*_list arrays must never be coerced into arithmetic.
      expect(computeFantasyPoints({ fg_made_list: [42, 51] }, format)).toBe(0);
    }
  });

  it('rounds float accumulation so displayed and summed points agree', () => {
    // 182 * 0.04 + 2 * 4 + 17 * 0.1 + 6 accumulates to 22.979999… in binary float.
    const allen = { passing_yards: 182, passing_tds: 2, rushing_yards: 17, rushing_tds: 1 };
    expect(computeFantasyPoints(allen, 'std')).toBe(22.98);
  });

  it('scores return TDs but not fumble-recovery TDs', () => {
    // nflverse's asymmetry, reproduced deliberately — both branches are load
    // bearing for the provider cross-check above.
    expect(computeFantasyPoints({ special_teams_tds: 1 }, 'std')).toBe(6);
    expect(computeFantasyPoints({ fumble_recovery_tds: 1 }, 'std')).toBe(0);
  });

  it('penalises fumbles from the offensive splits, ignoring the aggregate', () => {
    // One offensive fumble lost, counted once — not once per split column.
    expect(computeFantasyPoints({ fumbles_lost_total: 1, sack_fumbles_lost: 1 }, 'std')).toBe(-2);
    expect(
      computeFantasyPoints({ sack_fumbles_lost: 1, rushing_fumbles_lost: 1 }, 'std'),
    ).toBe(-4);
    // A fumble lost with no offensive split (return fumble) is not charged here,
    // matching nflverse's own fantasy_points. See the note in fantasy-scoring.ts.
    expect(computeFantasyPoints({ fumbles_lost_total: 1 }, 'std')).toBe(0);
  });
});
