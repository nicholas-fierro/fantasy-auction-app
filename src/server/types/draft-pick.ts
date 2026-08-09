import { Player } from './player';
import { FantasyTeam } from './fantasy-team';

export interface DraftPick {
  id: string;
  auction_id: string;
  fantasy_team_id: string;
  player_id: string;
  pick_order: number;
  price: number | null;
  timestamp: string;
  created: string;
  updated: string;
}

export interface DraftPickWithDetails {
  id: string;
  auction_id: string;
  fantasy_team_id: string;
  player_id: string;
  pick_order: number;
  price: number | null;
  timestamp: string;
  created: string;
  updated: string;
  player: Player;
  team: FantasyTeam;
}

// pick_order is intentionally absent: PocketBase assigns it server-side
// (pb_hooks/draft_picks_pick_order.pb.js) so concurrent writers can't race.
export interface CreateDraftPick {
  auction_id: string;
  fantasy_team_id: string;
  player_id: string;
  price?: number | null;
}
