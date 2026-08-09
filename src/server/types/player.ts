// The app-facing player shape is flattened: identity (name, position) comes from
// the `players` record and the stat fields come from the `player_seasons` row for
// the selected year. `id` stays the `players` record id so draft_picks / watchlist
// / ActiveDraftContext keying is unchanged; `season_id` is the `player_seasons`
// row id (used when persisting per-season edits).
export interface Player {
  id: string;
  season_id: string;
  name: string;
  team: string;
  position: string;
  position_rank: number;
  bye_week: number;
  sos: number;
  ecr_vs_adp: number;
  rank: number;
  tier: number;
  projected_auction_value: number | null;
  is_rookie: boolean;
  gsis_id: string | null;
  sleeper_id: string | null;
  espn_id: string | null;
  // Optional local mapping used only by the server-side FantasyPros adapter.
  // Keep this nullable so the comparison UI remains useful before a sync runs.
  fantasypros_id: string | null;
  created: string;
  updated: string;
}

// Raw per-season stats row (one per player per year).
export interface PlayerSeason {
  id: string;
  player_id: string;
  year: number;
  team: string;
  position_rank: number;
  bye_week: number;
  sos: number;
  ecr_vs_adp: number;
  rank: number;
  tier: number;
  projected_auction_value: number | null;
  actual_auction_value: number | null;
  is_rookie: boolean;
  created: string;
  updated: string;
}

export interface UpdatePlayerAuctionValues {
  projected_auction_value?: number | null;
}
