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
  // An outside league's imported board (scripts/import-external-auction.ts).
  // Readable so the value model can use it as comp data, but never part of this
  // league's draft list — auction-context filters these out of the UI.
  external: boolean;
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
