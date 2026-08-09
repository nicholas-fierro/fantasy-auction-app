import { computeFantasyPoints, type GameLogStats, type ScoringFormat } from '@/lib/fantasy-scoring';
import type { PlayerGameLog } from '@/server/types/player-game-log';

// Shapes raw player_game_logs rows into the week-by-week view the player modal
// renders. Pure so the postseason labelling and the bye/DNP grid — the parts
// most likely to be subtly wrong — are testable without React.

// The regular season grew from 16 to 17 games (17 to 18 calendar weeks) in 2021,
// and nflverse `week` numbers run straight through into the playoffs. Verified
// against the imported data: REG tops out at 17 with POST 18–21 through 2020,
// and REG 18 with POST 19–22 from 2021.
export function regularSeasonWeeks(season: number): number {
  return season <= 2020 ? 17 : 18;
}

/**
 * The `stats` keys this view actually reads — everything `computeFantasyPoints`
 * scores, plus the box-score columns and the per-category activity checks.
 *
 * PocketBase's `fields` param projects into a json column (`stats.receptions`),
 * which trims a career request from ~111 KB to ~64 KB. PocketBase serves these
 * responses uncompressed, so that halving is real bytes on the wire.
 *
 * IMPORTANT: adding a stat to a table column or to the scoring function means
 * adding its key here too. A missing key is not an error — it arrives absent and
 * scores as 0, silently. This list is the reason to keep that in one place.
 */
export const GAME_LOG_STAT_KEYS = [
  // Passing
  'completions',
  'attempts',
  'passing_yards',
  'passing_tds',
  'passing_interceptions',
  'sacks_suffered',
  'passing_2pt_conversions',
  'sack_fumbles_lost',
  // Rushing
  'carries',
  'rushing_yards',
  'rushing_tds',
  'rushing_2pt_conversions',
  'rushing_fumbles_lost',
  // Receiving
  'receptions',
  'targets',
  'receiving_yards',
  'receiving_tds',
  'receiving_2pt_conversions',
  'receiving_fumbles_lost',
  // Other scoring
  'special_teams_tds',
  // Kicking
  'fg_made',
  'fg_att',
  'fg_missed',
  'fg_long',
  'fg_made_0_19',
  'fg_made_20_29',
  'fg_made_30_39',
  'fg_made_40_49',
  'fg_made_50_59',
  'fg_made_60_',
  'pat_made',
  'pat_att',
] as const;

const POSTSEASON_ROUNDS = ['WC', 'DIV', 'CONF', 'SB'] as const;

/**
 * Round label for a postseason game.
 *
 * Derived from the week offset, deliberately *not* from the index of the row
 * within a team's playoff run: a team with a first-round bye opens in the
 * Divisional round, so counting rows would label every one of its games a round
 * too early.
 */
export function postseasonRoundLabel(season: number, week: number): string {
  const offset = week - regularSeasonWeeks(season);
  return POSTSEASON_ROUNDS[offset - 1] ?? `+${offset}`;
}

export type StatPage = 'passing' | 'rushing' | 'receiving' | 'kicking';

export type WeekRowKind = 'game' | 'bye' | 'dnp';

export interface WeekRow {
  key: string;
  /** "1"…"18" in the regular season, "WC"/"DIV"/"CONF"/"SB" in the playoffs. */
  label: string;
  opponent: string;
  kind: WeekRowKind;
  stats: GameLogStats;
  points: number;
}

export interface SeasonView {
  regular: WeekRow[];
  post: WeekRow[];
  /** Median points across regular-season games actually played. */
  median: number | null;
  /** Largest points value in the season, playoffs included — the bar y-scale. */
  maxPoints: number;
}

const EMPTY_STATS: GameLogStats = {};

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function seasonsWithLogs(logs: readonly PlayerGameLog[]): number[] {
  return [...new Set(logs.map((log) => log.season))].sort((a, b) => b - a);
}

/**
 * The season to show on open: the auction's own year when the player has logs
 * for it, otherwise their most recent season with data. Auction years run ahead
 * of played football (a 2026 draft has no 2026 games), so the fallback is the
 * normal path, not an edge case.
 */
export function defaultSeason(seasons: readonly number[], preferred: number): number | null {
  if (seasons.length === 0) return null;
  return seasons.includes(preferred) ? preferred : seasons[0];
}

/**
 * Which stat tables to offer, most relevant first. The second page appears only
 * when the player actually did something in that category this season, so a
 * non-rushing WR never gets an empty Rushing tab.
 */
export function statPagesForSeason(position: string, logs: readonly PlayerGameLog[]): StatPage[] {
  const total = (key: string) =>
    logs.reduce((sum, log) => {
      const value = log.stats[key];
      return sum + (typeof value === 'number' ? value : 0);
    }, 0);

  const rushing = total('carries') > 0;
  const receiving = total('targets') > 0 || total('receptions') > 0;
  const passing = total('attempts') > 0;
  const kicking = total('fg_att') > 0 || total('pat_att') > 0;

  const pages: StatPage[] = [];
  switch (position.toUpperCase()) {
    case 'QB':
      pages.push('passing');
      if (rushing) pages.push('rushing');
      break;
    case 'RB':
      pages.push('rushing');
      if (receiving) pages.push('receiving');
      break;
    case 'WR':
    case 'TE':
      pages.push('receiving');
      if (rushing) pages.push('rushing');
      break;
    case 'K':
    case 'PK':
      pages.push('kicking');
      break;
    default:
      // Unknown/DST: fall back to whatever the player actually did rather than
      // showing nothing, so an odd position string still renders.
      if (passing) pages.push('passing');
      if (rushing) pages.push('rushing');
      if (receiving) pages.push('receiving');
      if (kicking) pages.push('kicking');
  }
  return pages;
}

/**
 * Build one season's rows.
 *
 * The regular season renders as a full 1..N grid rather than only the weeks with
 * data, so a stretch of missed games reads as missed games — that absence is
 * signal when you're valuing a player. `byeWeek` comes from the player's
 * `player_seasons` row: a bye and an injury both leave no game log, and they
 * must not look the same.
 *
 * ponytail: a season still in progress would show its unplayed future weeks as
 * DNP. Harmless for the imported 2018–2025 history; if in-season data ever lands
 * here, clamp the grid to the league's latest played week.
 */
export function buildSeasonView(
  logs: readonly PlayerGameLog[],
  season: number,
  byeWeek: number | null,
  format: ScoringFormat,
): SeasonView {
  const forSeason = logs.filter((log) => log.season === season);
  const byWeek = new Map(
    forSeason.filter((log) => log.season_type === 'REG').map((log) => [log.week, log]),
  );

  const regular: WeekRow[] = [];
  for (let week = 1; week <= regularSeasonWeeks(season); week += 1) {
    const log = byWeek.get(week);
    if (log) {
      regular.push({
        key: `reg-${week}`,
        label: String(week),
        opponent: log.opponent,
        kind: 'game',
        stats: log.stats,
        points: computeFantasyPoints(log.stats, format),
      });
    } else {
      regular.push({
        key: `reg-${week}`,
        label: String(week),
        opponent: '',
        kind: week === byeWeek ? 'bye' : 'dnp',
        stats: EMPTY_STATS,
        points: 0,
      });
    }
  }

  const post: WeekRow[] = forSeason
    .filter((log) => log.season_type === 'POST')
    .sort((a, b) => a.week - b.week)
    .map((log) => ({
      key: `post-${log.week}`,
      label: postseasonRoundLabel(season, log.week),
      opponent: log.opponent,
      kind: 'game' as const,
      stats: log.stats,
      points: computeFantasyPoints(log.stats, format),
    }));

  const playedRegular = regular.filter((row) => row.kind === 'game');
  return {
    regular,
    post,
    // Regular season only. Playoff games don't score in a regular-season league,
    // so folding them in would distort the baseline this median exists to show.
    median: median(playedRegular.map((row) => row.points)),
    maxPoints: Math.max(0, ...playedRegular.concat(post).map((row) => row.points)),
  };
}
