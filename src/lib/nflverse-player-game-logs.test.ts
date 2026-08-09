import { describe, expect, it } from 'vitest';
import Papa from 'papaparse';
import {
  DISTANCE_LIST_FIELDS,
  NUMERIC_STATS_FIELDS,
  parseNflverseCsv,
  parseGameLogRow,
} from '../../scripts/import-nflverse-player-game-logs';

function row(overrides: Record<string, string> = {}): Record<string, string> {
  const stats = Object.fromEntries(NUMERIC_STATS_FIELDS.map((field) => [field, '0']));
  const distances = Object.fromEntries(DISTANCE_LIST_FIELDS.map((field) => [field, '']));
  return {
    player_id: '00-0039999',
    season: '2025',
    week: '7',
    season_type: 'REG',
    game_id: '2025_07_DET_MIN',
    team: 'DET',
    opponent_team: 'MIN',
    ...stats,
    ...distances,
    ...overrides,
  };
}

describe('nflverse player game-log parser', () => {
  it('maps identity, numeric scoring inputs, and exact kick distances', () => {
    const parsed = parseGameLogRow(row({
      receptions: '6',
      receiving_yards: '87.5',
      fg_made: '3',
      fg_made_list: '25;43;52',
      fg_missed_list: '61',
      fantasy_points_ppr: '20.25',
    }));

    expect(parsed).toMatchObject({
      gsisId: '00-0039999',
      season: 2025,
      week: 7,
      seasonType: 'REG',
      gameId: '2025_07_DET_MIN',
      team: 'DET',
      opponent: 'MIN',
    });
    expect(parsed.stats.receptions).toBe(6);
    expect(parsed.stats.receiving_yards).toBe(87.5);
    expect(parsed.stats.fg_made_list).toEqual([25, 43, 52]);
    expect(parsed.stats.fg_missed_list).toEqual([61]);
    expect(parsed.stats.fg_blocked_list).toEqual([]);
    expect(parsed.stats.fantasy_points_ppr).toBe(20.25);
  });

  it('keeps missing numeric values null and rejects corrupt values', () => {
    expect(parseGameLogRow(row({ targets: '' })).stats.targets).toBeNull();
    expect(() => parseGameLogRow(row({ rushing_yards: 'oops' }))).toThrow(
      'Invalid rushing_yards value',
    );
  });

  it('ignores anonymous team aggregate rows in older seasons', () => {
    const playerRow = row();
    const csv = Papa.unparse([
      row({ player_id: '', opponent_team: '' }),
      playerRow,
    ], { columns: Object.keys(playerRow) });

    expect(parseNflverseCsv(csv, 2025)).toHaveLength(1);
  });
});
