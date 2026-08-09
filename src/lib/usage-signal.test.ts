import { describe, expect, it } from 'vitest';
import { mergeStats } from '../../scripts/import-nflverse-player-game-logs';
import { buildIdentitySources } from '../../scripts/import-nflverse-snap-counts';
import {
  ageAtSeason,
  applyStandardizer,
  auc,
  buildUsageFeatures,
  fitLogistic,
  fitStandardizer,
  halfPpr,
  leaveOneSeasonOut,
  median,
  predictLogistic,
  replacementBaselines,
  seasonPoints,
  spearman,
  type CohortRow,
  type GameLogRow,
} from './usage-signal';

const log = (
  player_id: string,
  week: number,
  stats: GameLogRow['stats'],
  team = 'AAA',
  season = 2024
): GameLogRow => ({ player_id, season, week, team, stats });

describe('halfPpr', () => {
  it('is the midpoint of the standard and PPR columns', () => {
    expect(halfPpr({ fantasy_points: 10, fantasy_points_ppr: 16 })).toBe(13);
  });

  it('treats missing columns as zero', () => {
    expect(halfPpr({})).toBe(0);
  });
});

describe('seasonPoints', () => {
  it('sums weeks 1-17 and ignores week 18', () => {
    const logs = [
      log('p1', 1, { fantasy_points: 10, fantasy_points_ppr: 10 }),
      log('p1', 17, { fantasy_points: 4, fantasy_points_ppr: 8 }),
      log('p1', 18, { fantasy_points: 100, fantasy_points_ppr: 100 }),
    ];
    expect(seasonPoints(logs).get('p1|2024')).toBe(16);
  });
});

describe('median', () => {
  it('averages the middle pair on even counts', () => {
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  it('returns 0 for an empty pool', () => {
    expect(median([])).toBe(0);
  });
});

describe('replacementBaselines', () => {
  it('takes the weekly median across the free-pick pool and sums the season', () => {
    // Two RBs available for $0: one scores 10/wk, the other 20/wk. The weekly
    // median is 15, so a 17-week season baseline is 255.
    const logs: GameLogRow[] = [];
    for (let week = 1; week <= 17; week++) {
      logs.push(log('rb1', week, { fantasy_points: 10, fantasy_points_ppr: 10 }));
      logs.push(log('rb2', week, { fantasy_points: 20, fantasy_points_ppr: 20 }));
    }
    const baselines = replacementBaselines(
      logs,
      new Map([[2024, ['rb1', 'rb2']]]),
      new Map([
        ['rb1', 'RB'],
        ['rb2', 'RB'],
      ])
    );
    expect(baselines.get('2024|RB')).toBe(255);
  });

  it('counts a missing week as a zero rather than skipping it', () => {
    // One player, one week of production out of 17. Median of a single-member
    // pool is that member, so the baseline is just his one scoring week.
    const baselines = replacementBaselines(
      [log('rb1', 3, { fantasy_points: 12, fantasy_points_ppr: 18 })],
      new Map([[2024, ['rb1']]]),
      new Map([['rb1', 'RB']])
    );
    expect(baselines.get('2024|RB')).toBe(15);
  });
});

describe('buildUsageFeatures', () => {
  it('computes shares against team totals from the games played', () => {
    const logs = [
      log('wr1', 1, { targets: 10, receptions: 6, receiving_yards: 100, receiving_tds: 1 }),
      log('wr2', 1, { targets: 10, receptions: 5, receiving_yards: 50 }),
      log('wr1', 2, { targets: 6, receptions: 3, receiving_yards: 30 }),
      log('wr2', 2, { targets: 14, receptions: 7, receiving_yards: 70 }),
    ];
    const features = buildUsageFeatures(logs).get('wr1');
    expect(features).toBeDefined();
    expect(features!.games_played).toBe(2);
    expect(features!.targets_pg).toBe(8);
    // 16 of the team's 40 targets across both games.
    expect(features!.target_share).toBeCloseTo(0.4, 10);
    // 9 receptions, 130 yards, no carries.
    expect(features!.yards_per_touch).toBeCloseTo(130 / 9, 10);
    expect(features!.td_rate).toBeCloseTo(1 / 9, 10);
  });

  it('does not credit a player with share from games he missed', () => {
    const logs = [
      log('rb1', 1, { carries: 10 }),
      log('rb2', 1, { carries: 10 }),
      // Week 2: rb1 is out, rb2 takes the whole backfield.
      log('rb2', 2, { carries: 25 }),
    ];
    const features = buildUsageFeatures(logs).get('rb1');
    // 10 of the 20 carries in the one game he played, not 10 of 45.
    expect(features!.carry_share).toBeCloseTo(0.5, 10);
    expect(features!.games_played).toBe(1);
  });

  it('separates late-season share from full-season share', () => {
    const logs = [
      // Weeks 1-2: minor role.
      log('rb1', 1, { carries: 2 }),
      log('rb2', 1, { carries: 18 }),
      log('rb1', 2, { carries: 2 }),
      log('rb2', 2, { carries: 18 }),
      // Weeks 10-11: took over the backfield.
      log('rb1', 10, { carries: 18 }),
      log('rb2', 10, { carries: 2 }),
      log('rb1', 11, { carries: 18 }),
      log('rb2', 11, { carries: 2 }),
    ];
    const features = buildUsageFeatures(logs).get('rb1');
    expect(features!.carry_share).toBeCloseTo(0.5, 10);
    expect(features!.last8_carry_share).toBeCloseTo(0.9, 10);
  });

  it('ignores weeks past the fantasy season', () => {
    const features = buildUsageFeatures([
      log('wr1', 1, { targets: 5 }),
      log('wr1', 18, { targets: 100 }),
    ]).get('wr1');
    expect(features!.games_played).toBe(1);
    expect(features!.targets_pg).toBe(5);
  });
});

describe('spearman', () => {
  it('is 1 for a monotone increasing relationship regardless of scale', () => {
    expect(spearman([1, 2, 3, 4], [10, 200, 3000, 40000])).toBeCloseTo(1, 10);
  });

  it('is -1 for a monotone decreasing relationship', () => {
    expect(spearman([1, 2, 3, 4], [4, 3, 2, 1])).toBeCloseTo(-1, 10);
  });

  it('handles ties with average ranks', () => {
    expect(spearman([1, 1, 2, 2], [1, 1, 2, 2])).toBeCloseTo(1, 10);
  });
});

describe('auc', () => {
  it('is 1 for a perfect separator', () => {
    expect(auc([0.1, 0.2, 0.8, 0.9], [0, 0, 1, 1])).toBe(1);
  });

  it('is 0 when the ranking is exactly inverted', () => {
    expect(auc([0.9, 0.8, 0.2, 0.1], [0, 0, 1, 1])).toBe(0);
  });

  it('is 0.5 when every score ties', () => {
    expect(auc([0.5, 0.5, 0.5, 0.5], [0, 1, 0, 1])).toBe(0.5);
  });

  it('is NaN when a fold has only one class, rather than a misleading 0.5', () => {
    expect(auc([0.1, 0.9], [1, 1])).toBeNaN();
  });
});

describe('fitLogistic', () => {
  it('recovers the sign of a separating feature', () => {
    const rows = [[-2], [-1], [-0.5], [0.5], [1], [2]];
    const labels = [0, 0, 0, 1, 1, 1];
    const std = fitStandardizer(rows);
    const model = fitLogistic(applyStandardizer(rows, std), labels);
    expect(model.weights[0]).toBeGreaterThan(0);
    const predictions = predictLogistic(model, applyStandardizer(rows, std));
    expect(auc(predictions, labels)).toBe(1);
  });

  it('shrinks a pure-noise feature toward zero', () => {
    // Feature 0 separates, feature 1 is constant noise.
    const rows = [
      [-2, 1],
      [-1, 1],
      [1, 1],
      [2, 1],
    ];
    const model = fitLogistic(
      applyStandardizer(rows, fitStandardizer(rows)),
      [0, 0, 1, 1]
    );
    expect(Math.abs(model.weights[1])).toBeLessThan(1e-6);
  });
});

describe('snap features', () => {
  it('averages snap share over the games that have snap data, not the whole season', () => {
    // Two games played, one of them imported before snap counts existed. The
    // missing game must shrink the denominator rather than count as 0%.
    const features = buildUsageFeatures([
      log('p1', 1, { offense_snaps: 60, offense_pct: 0.9, carries: 10 }),
      log('p1', 2, { carries: 10 }),
    ]).get('p1')!;
    expect(features.games_played).toBe(2);
    expect(features.snap_pct).toBeCloseTo(0.9);
  });

  it('counts only games at or above half the offensive snaps', () => {
    const features = buildUsageFeatures([
      log('p1', 1, { offense_pct: 0.5 }),
      log('p1', 2, { offense_pct: 0.49 }),
      log('p1', 3, { offense_pct: 0.8 }),
    ]).get('p1')!;
    expect(features.games_50pct_snaps).toBe(2);
  });

  it('reports a rising late-season role as a positive trend', () => {
    const features = buildUsageFeatures([
      log('p1', 1, { offense_pct: 0.2 }),
      log('p1', 12, { offense_pct: 0.8 }),
    ]).get('p1')!;
    expect(features.last8_snap_pct).toBeCloseTo(0.8);
    expect(features.snap_pct_trend).toBeCloseTo(0.3); // 0.8 late vs 0.5 overall
  });

  it('leaves the trend at zero when no late-season game has snap data', () => {
    const features = buildUsageFeatures([log('p1', 1, { offense_pct: 0.9 })]).get('p1')!;
    expect(features.snap_pct_trend).toBe(0);
  });

  it('is the point of the exercise: snaps with no touches score zero opportunity, not undefined', () => {
    const features = buildUsageFeatures([
      log('p1', 1, { offense_snaps: 40, offense_pct: 0.6, targets: 0, carries: 0 }),
    ]).get('p1')!;
    expect(features.snap_pct).toBeCloseTo(0.6);
    expect(features.opportunity_per_snap).toBe(0);
  });

  it('counts opportunities only from the games its snap denominator covers', () => {
    // Week 2 predates the snap import. Charging its 10 touches against week 1's
    // 50 snaps would report 0.3 opportunities per snap instead of the true 0.1.
    const features = buildUsageFeatures([
      log('p1', 1, { offense_snaps: 50, offense_pct: 0.8, targets: 3, carries: 2 }),
      log('p1', 2, { targets: 5, carries: 5 }),
    ]).get('p1')!;
    expect(features.opportunity_per_snap).toBeCloseTo(0.1);
  });

  it('does not divide by zero when a season has no snap data at all', () => {
    const features = buildUsageFeatures([log('p1', 1, { targets: 5, carries: 5 })]).get('p1')!;
    expect(features.snap_pct).toBe(0);
    expect(features.opportunity_per_snap).toBe(0);
  });
});

describe('ageAtSeason', () => {
  it('measures to the September kickoff, so a January birthday is a year older', () => {
    // Same birth year, six months apart: the January-born player is measured as
    // ~0.5 years older at the same kickoff.
    const jan = ageAtSeason('1998-01-15', 2024)!;
    const jul = ageAtSeason('1998-07-15', 2024)!;
    expect(jan).toBeCloseTo(26.6, 1);
    expect(jul).toBeCloseTo(26.1, 1);
    expect(jan - jul).toBeCloseTo(0.5, 1);
  });

  it('returns null rather than a number for a missing or malformed date', () => {
    expect(ageAtSeason('', 2024)).toBeNull();
    expect(ageAtSeason(null, 2024)).toBeNull();
    expect(ageAtSeason('15/01/1998', 2024)).toBeNull();
    expect(ageAtSeason('1800-01-01', 2024)).toBeNull();
  });
});

describe('buildIdentitySources', () => {
  const roster = (over: Record<string, string> = {}) => ({
    gsis_id: '00-0001',
    pfr_id: 'SmitJo00',
    birth_date: '1998-01-15',
    ...over,
  });

  it('prefers the roster pfr mapping over the crosswalk', () => {
    const { gsisByPfrId } = buildIdentitySources(
      [roster()],
      [{ pfr_id: 'SmitJo00', gsis_id: '00-9999', birthdate: '1990-01-01' }]
    );
    expect(gsisByPfrId.get('SmitJo00')).toBe('00-0001');
  });

  it('still takes the crosswalk birth date when the roster row omits one', () => {
    // The roster supplies the identity mapping, so the crosswalk row is not
    // needed for pfr_id — but it is the only place the birth date exists.
    const { birthDateByGsisId } = buildIdentitySources(
      [roster({ birth_date: '' })],
      [{ pfr_id: 'SmitJo00', gsis_id: '00-0001', birthdate: '1998-01-15' }]
    );
    expect(birthDateByGsisId.get('00-0001')).toBe('1998-01-15');
  });

  it('rejects the "NA" both sources use for a missing date', () => {
    const { birthDateByGsisId } = buildIdentitySources(
      [roster({ birth_date: 'NA' })],
      [{ pfr_id: 'SmitJo00', gsis_id: '00-0001', birthdate: 'NA' }]
    );
    expect(birthDateByGsisId.has('00-0001')).toBe(false);
  });

  it('fills a pfr_id the rosters never listed', () => {
    const { gsisByPfrId } = buildIdentitySources(
      [],
      [{ pfr_id: 'JoneAl00', gsis_id: '00-0002', birthdate: '2000-05-05' }]
    );
    expect(gsisByPfrId.get('JoneAl00')).toBe('00-0002');
  });
});

describe('mergeStats', () => {
  it('keeps keys another importer owns while overwriting its own', () => {
    const merged = mergeStats({ carries: 1, offense_snaps: 40 }, { carries: 9, targets: 3 });
    expect(merged).toEqual({ carries: 9, targets: 3, offense_snaps: 40 });
  });

  it('falls back to the incoming stats when the stored value is not an object', () => {
    expect(mergeStats(null, { carries: 1 })).toEqual({ carries: 1 });
    expect(mergeStats([1, 2], { carries: 1 })).toEqual({ carries: 1 });
  });
});

describe('fitStandardizer', () => {
  it('leaves a constant column at zero instead of dividing by zero', () => {
    const rows = [
      [5, 1],
      [7, 1],
    ];
    const standardized = applyStandardizer(rows, fitStandardizer(rows));
    expect(standardized.every((row) => Number.isFinite(row[1]) && row[1] === 0)).toBe(true);
  });
});

describe('leaveOneSeasonOut', () => {
  const row = (year: number, signal: number, hit: 0 | 1): CohortRow => ({
    year,
    playerId: `p${year}-${signal}-${hit}`,
    name: 'test',
    position: 'RB',
    price: 10,
    positionRank: 40,
    features: {
      games_played: 16,
      targets_pg: 0,
      target_share: 0,
      carries_pg: signal,
      carry_share: 0,
      rec_per_carry: 0,
      yards_per_touch: 0,
      td_rate: 0,
      last8_target_share: 0,
      last8_carry_share: 0,
      snap_pct: 0,
      last8_snap_pct: 0,
      snap_pct_trend: 0,
      opportunity_per_snap: 0,
      games_50pct_snaps: 0,
    },
    age: 25,
    points: 0,
    surplus: 0,
    hit,
  });

  it('scores every season and recovers a clean signal out of sample', () => {
    const cohort: CohortRow[] = [];
    for (const year of [2021, 2022, 2023]) {
      for (const signal of [1, 2, 3]) cohort.push(row(year, signal, 0));
      for (const signal of [8, 9, 10]) cohort.push(row(year, signal, 1));
    }
    const result = leaveOneSeasonOut(cohort, (r) => [r.features.carries_pg]);
    expect(result.folds.map((fold) => fold.year)).toEqual([2021, 2022, 2023]);
    expect(result.meanAuc).toBe(1);
  });

  it('lands near chance when the feature carries no information', () => {
    const cohort: CohortRow[] = [];
    for (const year of [2021, 2022, 2023]) {
      for (const signal of [1, 2, 3, 4]) {
        cohort.push(row(year, signal, signal % 2 === 0 ? 1 : 0));
      }
    }
    const result = leaveOneSeasonOut(cohort, (r) => [r.features.carries_pg]);
    expect(result.meanAuc).toBeGreaterThan(0.2);
    expect(result.meanAuc).toBeLessThan(0.8);
  });

  it('skips a single-class fold instead of averaging it in', () => {
    const cohort: CohortRow[] = [
      row(2021, 1, 0),
      row(2021, 9, 1),
      row(2022, 1, 1),
      row(2022, 9, 1),
    ];
    const result = leaveOneSeasonOut(cohort, (r) => [r.features.carries_pg]);
    expect(result.folds.find((fold) => fold.year === 2022)?.auc).toBeNaN();
    // Only the 2021 fold is scorable, and it trains purely on 2022's all-positive
    // rows, so it learns nothing and lands at chance. The mean must be that 0.5
    // alone — the NaN fold contributes nothing rather than a phantom 0.5.
    expect(result.meanAuc).toBe(0.5);
  });
});
