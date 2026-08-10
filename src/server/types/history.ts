// A single historical price observation used to estimate future auction costs.
// Sourced either from an official auction's real pick price ('official'), from
// imported pre-app history stored on `player_seasons.actual_auction_value`
// ('imported'), or synthesized as a $0 row for a ranked player who went
// undrafted in a completed official auction ('undrafted'), or from another
// league's imported board ('external', including its own undrafted rows) — see
// computeHistoricalValues in src/lib/history-client.ts. Only trusted
// historical data lands here — mock auctions and snake (price-less) picks are
// excluded upstream. 'external' rows are the only ones that may come from the
// draft year itself, and the model discounts them by externalWeight.
export interface HistoricalValue {
  year: number;
  player_id: string;
  name: string;
  position: string;
  rank: number;
  position_rank: number;
  price: number;
  source: 'official' | 'imported' | 'undrafted' | 'external';
  // Mirrors `source === 'external'`. The value model is generic over
  // HistoryRow, which has no notion of this app's provenance labels, so the
  // flag it actually weights on has to be present on the row itself.
  external?: boolean;

}
