export interface Watchlist {
  id: string;
  user: string;
  player_id: string;
  watch_order: number;
  // Manual multiplier on the mock draft's market value for this player. 1 = no
  // opinion. See computeBase in src/lib/mock-draft/pricing.ts.
  market_nudge: number;
  created: string;
  updated: string;
}

export interface WatchlistWithDetails extends Watchlist {
  player: {
    id: string;
    season_id: string;
    name: string;
    team: string;
    position: string;
    bye_week: number;
    rank: number;
    tier: number;
    position_rank: number;
    sos: number;
    ecr_vs_adp: number | null;
    projected_auction_value: number | null;
    is_rookie: boolean;
    gsis_id: string | null;
    sleeper_id: string | null;
    espn_id: string | null;
    fantasypros_id: string | null;
    created: string;
    updated: string;
  };
}

export interface CreateWatchlistData {
  user: string;
  player_id: string;
  watch_order: number;
}

export interface UpdateWatchlistOrderData {
  id: string;
  watch_order: number;
}
