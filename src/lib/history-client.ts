import type PocketBase from 'pocketbase';
import type { RecordModel } from 'pocketbase';
import { pb } from '@/lib/pb-client';
import type { HistoricalValue } from '@/server/types/history';
import { seasonRankingValue } from '@/lib/season-rankings';
import {
  historyAuctionFilter,
  loadLeagueHistoryScope,
  selectHistoryAuctions,
  type HistoryAuction,
} from '@/lib/league-history';

const SYNTHESIZABLE_POSITIONS = new Set(['QB', 'RB', 'WR', 'TE']);

// API rules authorize reads; the explicit league scopes what a dual member sees.
export async function computeHistoricalValues(
  leagueId: string,
  client: PocketBase = pb
): Promise<HistoricalValue[]> {
  const scope = await loadLeagueHistoryScope(client, leagueId);
  if (scope.settings.draftFormat === 'snake') return [];
  const records = await client.collection('auctions').getFullList<RecordModel & HistoryAuction>({
    filter: historyAuctionFilter(client, scope),
    requestKey: null,
  });
  const auctions = selectHistoryAuctions(records, scope);
  const seasonMaps = new Map<number, Promise<Map<string, RecordModel>>>();
  const seasonMapFor = (year: number) => {
    let result = seasonMaps.get(year);
    if (!result) {
      result = client.collection('player_seasons').getFullList({
        filter: client.filter('year = {:year}', { year }),
        expand: 'player_id',
        requestKey: null,
      }).then((rows) => new Map(rows.map((row) => [String(row.player_id), row])));
      seasonMaps.set(year, result);
    }
    return result;
  };

  const perAuction = await Promise.all(auctions.map(async (auction) => {
    const [picks, seasons] = await Promise.all([
      client.collection('draft_picks').getFullList({
        filter: client.filter('auction_id = {:id} && price > 0', { id: auction.id }),
        expand: 'player_id',
        requestKey: null,
      }),
      seasonMapFor(auction.year),
    ]);
    const rows: HistoricalValue[] = [];
    const drafted = new Set<string>();
    for (const pick of picks) {
      const playerId = String(pick.player_id);
      drafted.add(playerId);
      // A priced pick with no season row for that year carries no rank to key
      // comps off — skipping keeps a $40 price out of the top of the board.
      const season = seasons.get(playerId);
      if (!season) continue;
      const player = pick.expand?.player_id;
      rows.push({
        year: auction.year,
        player_id: playerId,
        name: player?.name ?? '',
        position: player?.position ?? '',
        rank: seasonRankingValue(season ?? {}, 'rank', scope.settings.scoringFormat),
        position_rank: seasonRankingValue(season ?? {}, 'position_rank', scope.settings.scoringFormat),
        price: Number(pick.price),
        source: auction.external ? 'external' : 'official',
        external: auction.external === true,
      });
    }
    // Completed boards alone can say that a ranked player went unpriced.
    if (auction.status === 'completed') {
      for (const season of seasons.values()) {
        const playerId = String(season.player_id);
        if (drafted.has(playerId)) continue;
        const positionRank = seasonRankingValue(season, 'position_rank', scope.settings.scoringFormat);
        const player = season.expand?.player_id;
        if (positionRank <= 0 || !SYNTHESIZABLE_POSITIONS.has(player?.position)) continue;
        rows.push({
          year: auction.year,
          player_id: playerId,
          name: player?.name ?? '',
          position: player?.position ?? '',
          rank: seasonRankingValue(season, 'rank', scope.settings.scoringFormat),
          position_rank: positionRank,
          price: 0,
          source: auction.external ? 'external' : 'undrafted',
          external: auction.external === true,
        });
      }
    }
    return rows;
  }));
  // The legacy player_seasons.actual_auction_value fallback was unscoped. All
  // imported history is now first-class official auctions (AD-13); no fallback.
  return perAuction.flat();
}
