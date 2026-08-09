// A single historical price observation used to estimate future auction costs.
// Sourced either from an official auction's real pick price ('official'), from
// imported pre-app history stored on `player_seasons.actual_auction_value`
// ('imported'), or synthesized as a $0 row for a ranked player who went
// undrafted in a completed official auction ('undrafted') — see
// computeHistoricalValues in src/lib/history-client.ts. Only trusted
// historical data lands here — mock auctions and snake (price-less) picks are
// excluded upstream.
export interface HistoricalValue {
  year: number;
  player_id: string;
  name: string;
  position: string;
  rank: number;
  position_rank: number;
  price: number;
  source: 'official' | 'imported' | 'undrafted';
}
