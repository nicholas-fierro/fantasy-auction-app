// App-owned fantasy scoring. `player_game_logs.stats` holds raw nflverse inputs
// plus the provider's own `fantasy_points` (standard) and `fantasy_points_ppr`,
// which AD-25 keeps as validation references only. Half-PPR — this league's
// actual format — has no provider column, so points are always derived here
// rather than read off the row. fantasy-scoring.test.ts pins std/ppr against
// the two provider columns so the reception multiplier stays the only variable.

export type ScoringFormat = 'std' | 'half' | 'ppr';

export const SCORING_FORMAT_LABELS: Record<ScoringFormat, string> = {
  std: 'Std',
  half: 'Half',
  ppr: 'PPR',
};

export function isScoringFormat(value: unknown): value is ScoringFormat {
  return value === 'std' || value === 'half' || value === 'ppr';
}

// Mirrors the importer's GameLogStats: every NUMERIC_STATS_FIELDS key is a
// nullable number, every DISTANCE_LIST_FIELDS key a number[]. Missing/NA source
// values are stored as null, so nothing here may assume a key is present.
export type GameLogStats = Record<string, number | number[] | null | undefined>;

const POINTS_PER_RECEPTION: Record<ScoringFormat, number> = {
  std: 0,
  half: 0.5,
  ppr: 1,
};

function n(stats: GameLogStats, key: string): number {
  const value = stats[key];
  return typeof value === 'number' ? value : 0;
}

// Field goals score by distance. nflverse pre-buckets makes and misses, so this
// reads the buckets rather than the fg_*_list arrays — the lists exist for
// display (longest kick) and would double-count if summed here too.
function kickingPoints(stats: GameLogStats): number {
  const madeShort = n(stats, 'fg_made_0_19') + n(stats, 'fg_made_20_29') + n(stats, 'fg_made_30_39');
  const made40s = n(stats, 'fg_made_40_49');
  const madeLong = n(stats, 'fg_made_50_59') + n(stats, 'fg_made_60_');

  return (
    madeShort * 3 +
    made40s * 4 +
    madeLong * 5 +
    n(stats, 'pat_made') -
    n(stats, 'fg_missed')
  );
}

/**
 * Fantasy points for one game log row under the given scoring format.
 *
 * Offense uses conventional scoring: 1pt/25 passing yards, 4/passing TD,
 * -2/interception, 1pt/10 rushing+receiving yards, 6/TD, 2/two-point
 * conversion, -2/fumble lost, and the format's per-reception bonus.
 *
 * Kicking is added unconditionally rather than gated on position: the stats are
 * mutually exclusive in practice (a QB has no fg_made), and a position check
 * here would silently zero out a real kicker whose position string differs
 * ('PK', 'K'). Note that nflverse's fantasy_points column is offense-only and
 * absent on kicker rows, so kicking scoring has no provider column to check
 * against — see the test.
 */
export function computeFantasyPoints(stats: GameLogStats, format: ScoringFormat): number {
  const passing =
    n(stats, 'passing_yards') * 0.04 +
    n(stats, 'passing_tds') * 4 -
    n(stats, 'passing_interceptions') * 2;

  const rushing = n(stats, 'rushing_yards') * 0.1 + n(stats, 'rushing_tds') * 6;

  const receiving =
    n(stats, 'receiving_yards') * 0.1 +
    n(stats, 'receiving_tds') * 6 +
    n(stats, 'receptions') * POINTS_PER_RECEPTION[format];

  // Return TDs count; fumble-recovery TDs do not. That asymmetry is nflverse's,
  // not a guess — its fantasy_points includes special_teams_tds and omits
  // fumble_recovery_tds, and the cross-check test holds us to both. ponytail: a
  // league that pays out recovery TDs adds fumble_recovery_tds here and an
  // exception list to the test.
  const otherTds = n(stats, 'special_teams_tds') * 6;

  const twoPointConversions =
    (n(stats, 'passing_2pt_conversions') +
      n(stats, 'rushing_2pt_conversions') +
      n(stats, 'receiving_2pt_conversions')) *
    2;

  // Deliberately the three splits, not `fumbles_lost_total`. The aggregate also
  // counts fumbles lost on plays with no offensive split — kick/punt returns,
  // laterals — which nflverse's own fantasy_points ignores. Rare (2 rows in a
  // 10,746-row sample) but it breaks the provider cross-check that pins every
  // other coefficient in this function, and matching the provider is the more
  // defensible default. ponytail: if the league decides return fumbles should
  // cost points, switch to fumbles_lost_total and give the test an exception
  // list for those rows.
  const fumbles =
    (n(stats, 'sack_fumbles_lost') +
      n(stats, 'rushing_fumbles_lost') +
      n(stats, 'receiving_fumbles_lost')) *
    -2;

  const total =
    passing + rushing + receiving + otherTds + twoPointConversions + fumbles + kickingPoints(stats);

  // Float accumulation on 0.04/0.1 multipliers leaves noise like 22.979999…;
  // every consumer displays one decimal, so round here and keep totals/medians
  // consistent with the per-week numbers they summarize.
  return Math.round(total * 100) / 100;
}
