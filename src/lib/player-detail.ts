import type { HistoricalValue } from '@/server/types/history';
import type { Player } from '@/server/types/player';

export function playerFromHistoricalValue(
  row: HistoricalValue,
  currentPlayers: readonly Player[],
): Player {
  const currentPlayer = currentPlayers.find((player) => player.id === row.player_id);
  if (currentPlayer) return currentPlayer;

  return {
    id: row.player_id,
    season_id: '',
    name: row.name,
    team: '',
    position: row.position,
    position_rank: row.position_rank,
    bye_week: 0,
    sos: 0,
    ecr_vs_adp: 0,
    rank: row.rank,
    tier: 0,
    projected_auction_value: null,
    is_rookie: false,
    gsis_id: null,
    sleeper_id: null,
    espn_id: null,
    fantasypros_id: null,
    created: '',
    updated: '',
  };
}
