export interface Auction {
  id: string;
  name: string;
  year: number | null;
  type: 'official' | 'mock';
  // Whether this is an AI-simulated mock draft (only meaningful for type 'mock').
  sim: boolean;
  status: 'active' | 'completed';
  user: string;
  // The league this auction belongs to (empty for pre-league legacy rows).
  league: string | null;
  drafted_at: string;
  created: string;
  updated: string;
}

export interface CreateAuctionInput {
  name: string;
  year: number;
  type: 'official' | 'mock';
  sim?: boolean;
  teamOrder: {
    fantasy_team_id: string;
    draft_order: number;
  }[];
}

export type ReplaceAuctionResolution = 'complete' | 'delete';
