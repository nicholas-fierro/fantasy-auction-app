import type { GameLogStats } from '@/lib/fantasy-scoring';

// One row of `player_game_logs` — a single player's box score for a single game.
// The full stat line lives in the `stats` JSON blob (see AD-25): raw nflverse
// inputs, so points are derived per scoring format rather than stored.
export interface PlayerGameLog {
  id: string;
  player_id: string;
  season: number;
  week: number;
  season_type: SeasonType;
  game_id: string;
  team: string;
  opponent: string;
  stats: GameLogStats;
}

export type SeasonType = 'REG' | 'POST';
