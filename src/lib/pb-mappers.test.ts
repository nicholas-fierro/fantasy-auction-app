import { describe, expect, it } from 'vitest';
import type { RecordModel } from 'pocketbase';
import {
  mapPickRecord,
  mapSeasonRecord,
  mapSeasonToPlayer,
  mapWatchlistRecord,
} from '@/lib/pb-mappers';
import { seasonBoardImported, seasonRankingFieldName } from '@/lib/season-rankings';

const season = {
  id: 'season-1',
  player_id: 'player-1',
  year: 2026,
  team: 'CIN',
  position_rank: 2,
  rank: 4,
  tier: 2,
  ecr_vs_adp: -1,
  position_rank_ppr: 1,
  rank_ppr: 1,
  tier_ppr: 1,
  ecr_vs_adp_ppr: 3,
  bye_week: 10,
  sos: 4,
  projected_auction_value: 52,
  actual_auction_value: 0,
  is_rookie: false,
  created: '2026-01-01T00:00:00Z',
  updated: '2026-01-02T00:00:00Z',
  expand: {
    player_id: {
      id: 'player-1',
      name: "Ja'Marr Chase",
      position: 'WR',
      created: '2025-01-01T00:00:00Z',
      updated: '2025-01-02T00:00:00Z',
    },
  },
} as unknown as RecordModel;

describe('season ranking mappers', () => {
  it('uses legacy columns for half-PPR and parallel columns for full-PPR', () => {
    expect(mapSeasonToPlayer(season, 'half')).toMatchObject({
      position_rank: 2,
      rank: 4,
      tier: 2,
      ecr_vs_adp: -1,
    });
    expect(mapSeasonToPlayer(season, 'ppr')).toMatchObject({
      position_rank: 1,
      rank: 1,
      tier: 1,
      ecr_vs_adp: 3,
      team: 'CIN',
      bye_week: 10,
      sos: 4,
    });
    expect(mapSeasonRecord(season, 'ppr')).toMatchObject({
      position_rank: 1,
      rank: 1,
      tier: 1,
      ecr_vs_adp: 3,
    });
  });

  it('hydrates draft picks and watchlist rows from selected format', () => {
    const player = season.expand?.player_id;
    const pick = {
      id: 'pick-1',
      auction_id: 'auction-1',
      fantasy_team_id: 'team-1',
      player_id: 'player-1',
      pick_order: 1,
      price: 0,
      created: '2026-01-01T00:00:00Z',
      updated: '2026-01-01T00:00:00Z',
      expand: { player_id: player, fantasy_team_id: { id: 'team-1', name: 'Team 1' } },
    } as unknown as RecordModel;
    const watch = {
      id: 'watch-1',
      user: 'user-1',
      player_id: 'player-1',
      watch_order: 1,
      market_nudge: 1,
      created: '2026-01-01T00:00:00Z',
      updated: '2026-01-01T00:00:00Z',
      expand: { player_id: player },
    } as unknown as RecordModel;

    expect(mapPickRecord(pick, 'ppr', season).player).toMatchObject({
      position_rank: 1,
      rank: 1,
      tier: 1,
      ecr_vs_adp: 3,
    });
    expect(mapWatchlistRecord(watch, 'ppr', season).player).toMatchObject({
      position_rank: 1,
      rank: 1,
      tier: 1,
      ecr_vs_adp: 3,
    });
  });

  it('selects only full-PPR field names for PPR leagues', () => {
    expect(seasonRankingFieldName('rank', 'half')).toBe('rank');
    expect(seasonRankingFieldName('rank', 'std')).toBe('rank');
    expect(seasonRankingFieldName('rank', 'ppr')).toBe('rank_ppr');
  });

  it('detects whether a format board was imported', () => {
    expect(seasonBoardImported({ rank: 4, position_rank: 0, tier: 0 }, 'half')).toBe(true);
    expect(seasonBoardImported({ rank: 0, position_rank: 0, tier: 0 }, 'half')).toBe(false);
    expect(seasonBoardImported({}, 'ppr')).toBe(false);
    expect(seasonBoardImported({ rank_ppr: 3 }, 'ppr')).toBe(true);
    expect(seasonBoardImported({ rank: 4 }, 'ppr')).toBe(false);
  });
});
