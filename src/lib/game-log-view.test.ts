import { describe, expect, it } from 'vitest';
import type { PlayerGameLog } from '@/server/types/player-game-log';
import type { GameLogStats } from '@/lib/fantasy-scoring';
import {
  buildSeasonView,
  defaultSeason,
  postseasonRoundLabel,
  regularSeasonWeeks,
  seasonsWithLogs,
  statPagesForSeason,
} from './game-log-view';

function log(
  season: number,
  week: number,
  season_type: 'REG' | 'POST',
  stats: GameLogStats = {},
  opponent = 'OPP',
): PlayerGameLog {
  return {
    id: `${season}-${season_type}-${week}`,
    player_id: 'p1',
    season,
    week,
    season_type,
    game_id: `${season}_${week}`,
    team: 'TM',
    opponent,
    stats,
  };
}

describe('season length', () => {
  // Verified against the imported data: REG max week 17 for 2018/2020 and 18 for
  // 2021/2024.
  it('accounts for the 2021 expansion to 17 games', () => {
    expect(regularSeasonWeeks(2018)).toBe(17);
    expect(regularSeasonWeeks(2020)).toBe(17);
    expect(regularSeasonWeeks(2021)).toBe(18);
    expect(regularSeasonWeeks(2025)).toBe(18);
  });
});

describe('postseasonRoundLabel', () => {
  it('labels rounds off the week offset for both season lengths', () => {
    // 2018–2020: POST weeks 18–21.
    expect([18, 19, 20, 21].map((w) => postseasonRoundLabel(2019, w))).toEqual([
      'WC',
      'DIV',
      'CONF',
      'SB',
    ]);
    // 2021+: POST weeks 19–22.
    expect([19, 20, 21, 22].map((w) => postseasonRoundLabel(2024, w))).toEqual([
      'WC',
      'DIV',
      'CONF',
      'SB',
    ]);
  });

  it('labels a first-round-bye team by round, not by appearance order', () => {
    // The case an ordinal-based implementation gets wrong: a top seed's first
    // playoff game is the Divisional round, and its two games are DIV then CONF —
    // never WC then DIV.
    const topSeedRun = [log(2024, 20, 'POST'), log(2024, 21, 'POST')];
    const view = buildSeasonView(topSeedRun, 2024, null, 'half');
    expect(view.post.map((row) => row.label)).toEqual(['DIV', 'CONF']);
  });

  it('does not crash on an unexpected week beyond the Super Bowl', () => {
    expect(postseasonRoundLabel(2024, 23)).toBe('+5');
  });
});

describe('buildSeasonView', () => {
  const stats = (points: { receptions?: number; receiving_yards?: number }) => points;

  it('renders the full regular season, distinguishing bye from missed games', () => {
    const logs = [log(2024, 1, 'REG', stats({ receiving_yards: 100 }))];
    const view = buildSeasonView(logs, 2024, 5, 'half');

    expect(view.regular).toHaveLength(18);
    expect(view.regular[0].kind).toBe('game');
    // Week 5 is the bye; week 2 is simply a game the player did not play.
    expect(view.regular[4]).toMatchObject({ label: '5', kind: 'bye' });
    expect(view.regular[1]).toMatchObject({ label: '2', kind: 'dnp' });
  });

  it('keeps the median to regular-season games actually played', () => {
    // Regular season 10, 20, 30 → median 20. The 100-point playoff game and the
    // 15 unplayed weeks must not move it.
    const logs = [
      log(2024, 1, 'REG', { receiving_yards: 100 }), // 10
      log(2024, 2, 'REG', { receiving_yards: 200 }), // 20
      log(2024, 3, 'REG', { receiving_yards: 300 }), // 30
      log(2024, 19, 'POST', { receiving_yards: 1000 }), // 100
    ];
    const view = buildSeasonView(logs, 2024, null, 'std');
    expect(view.median).toBe(20);
    // The y-scale does include the playoff game, so bars stay comparable.
    expect(view.maxPoints).toBe(100);
  });

  it('has no median when the player never played a regular-season game', () => {
    expect(buildSeasonView([], 2024, null, 'half').median).toBeNull();
    expect(buildSeasonView([], 2024, null, 'half').maxPoints).toBe(0);
  });

  it('separates postseason rows and ignores other seasons', () => {
    const logs = [
      log(2023, 1, 'REG', { receiving_yards: 50 }),
      log(2024, 1, 'REG', { receiving_yards: 50 }),
      log(2024, 22, 'POST', { receiving_yards: 50 }),
    ];
    const view = buildSeasonView(logs, 2024, null, 'half');
    expect(view.regular.filter((r) => r.kind === 'game')).toHaveLength(1);
    expect(view.post.map((r) => r.label)).toEqual(['SB']);
  });

  it('recomputes points with the selected scoring format', () => {
    const logs = [log(2024, 1, 'REG', { receptions: 8, receiving_yards: 80 })];
    const points = (format: 'std' | 'half' | 'ppr') =>
      buildSeasonView(logs, 2024, null, format).regular[0].points;
    expect(points('std')).toBe(8);
    expect(points('half')).toBe(12);
    expect(points('ppr')).toBe(16);
  });
});

describe('season selection', () => {
  it('lists seasons newest first', () => {
    const logs = [log(2022, 1, 'REG'), log(2024, 1, 'REG'), log(2024, 2, 'REG'), log(2023, 1, 'REG')];
    expect(seasonsWithLogs(logs)).toEqual([2024, 2023, 2022]);
  });

  it('prefers the auction year, else the most recent season with data', () => {
    expect(defaultSeason([2025, 2024], 2024)).toBe(2024);
    // A 2026 auction has no 2026 games yet — the common case.
    expect(defaultSeason([2025, 2024], 2026)).toBe(2025);
    expect(defaultSeason([], 2026)).toBeNull();
  });
});

describe('statPagesForSeason', () => {
  it('defaults to the position’s primary category', () => {
    const passer = [log(2024, 1, 'REG', { attempts: 30, passing_yards: 250 })];
    expect(statPagesForSeason('QB', passer)).toEqual(['passing']);

    const rusher = [log(2024, 1, 'REG', { carries: 20, rushing_yards: 90 })];
    expect(statPagesForSeason('RB', rusher)).toEqual(['rushing']);

    const receiver = [log(2024, 1, 'REG', { targets: 8, receptions: 6 })];
    expect(statPagesForSeason('WR', receiver)).toEqual(['receiving']);
    expect(statPagesForSeason('TE', receiver)).toEqual(['receiving']);

    const kicker = [log(2024, 1, 'REG', { fg_att: 3, pat_att: 2 })];
    expect(statPagesForSeason('K', kicker)).toEqual(['kicking']);
  });

  it('adds the secondary page only when the player was active there', () => {
    const dualThreatQb = [log(2024, 1, 'REG', { attempts: 30, carries: 8 })];
    expect(statPagesForSeason('QB', dualThreatQb)).toEqual(['passing', 'rushing']);

    const receivingBack = [log(2024, 1, 'REG', { carries: 15, targets: 5 })];
    expect(statPagesForSeason('RB', receivingBack)).toEqual(['rushing', 'receiving']);

    const rushingWr = [log(2024, 1, 'REG', { targets: 6, carries: 2 })];
    expect(statPagesForSeason('WR', rushingWr)).toEqual(['receiving', 'rushing']);

    // A WR who never took a carry gets no empty Rushing tab.
    expect(statPagesForSeason('WR', [log(2024, 1, 'REG', { targets: 6 })])).toEqual(['receiving']);
  });

  it('returns nothing for a position with no offensive production, e.g. DST', () => {
    expect(statPagesForSeason('DST', [log(2024, 1, 'REG', {})])).toEqual([]);
  });
});
