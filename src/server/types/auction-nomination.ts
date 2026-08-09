export type AuctionNominationAction = 'nominate' | 'clear';

export interface AuctionNominationEvent {
  id: string;
  auction_id: string;
  player_id: string | null;
  user: string;
  action: AuctionNominationAction;
  event_order: number;
  pick_count: number;
  created: string;
}
