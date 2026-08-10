import { RecordModel } from 'pocketbase';
import { pb } from '@/lib/pb-client';
import { HistoricalValue } from '@/server/types/history';

// Client-side port of the server's computeHistoricalValues (src/server/lib/
// history-core.ts). Pure PB reads + in-memory joins over user-readable data, so
// it runs safely in the browser against the direct SDK. Scoping to the logged-in
// user is now enforced by the `auctions` API rule (user = @request.auth.id), so
// the explicit userId filter is dropped — the SDK's auth token does the scoping.

// Among several official auctions for the same year, pick one deterministically:
// completed drafts win over active ones, then newest-created breaks ties.
function chooseAuction(candidates: RecordModel[]): RecordModel {
  return [...candidates].sort((a, b) => {
    const aCompleted = a.status === 'completed' ? 0 : 1;
    const bCompleted = b.status === 'completed' ? 0 : 1;
    if (aCompleted !== bCompleted) return aCompleted - bCompleted;
    return new Date(b.created).getTime() - new Date(a.created).getTime();
  })[0];
}

// Groups official auctions by year and collapses each year's duplicates via
// chooseAuction. Shared with use-team-profiles.ts, which needs the same
// one-auction-per-year selection.
export function chosenAuctionsByYear(auctions: RecordModel[]): Map<number, RecordModel> {
  const byYear = new Map<number, RecordModel[]>();
  for (const auction of auctions) {
    const list = byYear.get(auction.year) ?? [];
    list.push(auction);
    byYear.set(auction.year, list);
  }
  const chosenByYear = new Map<number, RecordModel>();
  for (const [year, candidates] of byYear) {
    chosenByYear.set(year, chooseAuction(candidates));
  }
  return chosenByYear;
}

async function buildSeasonMap(year: number): Promise<Map<string, RecordModel>> {
  const rows = await pb.collection('player_seasons').getFullList({
    filter: pb.filter('year = {:year}', { year }),
    // Expanded so synthesized undrafted rows (below) can carry the player's
    // name/position without a second round trip.
    expand: 'player_id',
    requestKey: null,
  });
  return new Map(rows.map((row) => [row.player_id as string, row]));
}

// Positions the undrafted-synthesis rule applies to; K/DST are never
// synthesized (kickers/defenses routinely go unpriced for reasons unrelated
// to market value).
const SYNTHESIZABLE_POSITIONS = new Set(['QB', 'RB', 'WR', 'TE']);

export async function computeHistoricalValues(): Promise<HistoricalValue[]> {
  // 1. Official auctions that carry a year (auth-scoped by API rule).
  const officialAuctions = await pb.collection('auctions').getFullList({
    filter: pb.filter('type = "official" && year > 0'),
    requestKey: null,
  });

  // Outside-league boards are readable (migration 1784380000) but are NOT
  // candidates for "this league's auction for year N" — they must never
  // displace our own draft in the one-per-year collapse, and unlike ours they
  // may describe the year currently being drafted. They are appended as their
  // own discounted rows below.
  const leagueAuctions = officialAuctions.filter((a) => a.external !== true);
  const externalAuctions = officialAuctions.filter((a) => a.external === true);

  // Deterministically collapse duplicate official auctions per year.
  const chosenByYear = chosenAuctionsByYear(leagueAuctions);

  const rows: HistoricalValue[] = [];

  // 2. Official prices: each chosen auction's priced picks (excludes snake picks),
  //    joined in memory to that year's season rows. Per-year work runs in parallel.
  const perYear = await Promise.all(
    [...chosenByYear.entries()].map(async ([year, auction]) => {
      const [picks, seasonMap] = await Promise.all([
        pb.collection('draft_picks').getFullList({
          filter: pb.filter('auction_id = {:auctionId} && price > 0', { auctionId: auction.id }),
          expand: 'player_id',
          requestKey: null,
        }),
        buildSeasonMap(year),
      ]);

      const yearRows: HistoricalValue[] = [];
      const draftedPlayerIds = new Set<string>();
      for (const pick of picks) {
        const season = seasonMap.get(pick.player_id as string);
        if (!season) continue;
        const player = pick.expand?.player_id;
        yearRows.push({
          year,
          player_id: pick.player_id,
          name: player?.name ?? '',
          position: player?.position ?? '',
          rank: season.rank ?? 0,
          position_rank: season.position_rank ?? 0,
          price: pick.price,
          source: 'official',
        });
        draftedPlayerIds.add(pick.player_id as string);
      }

      // Synthesize $0 rows for every ranked QB/RB/WR/TE that went undrafted in
      // this year's official auction, so the weighted-median model learns that
      // most ranked players at deep positions (esp. QB/TE) simply don't get
      // bid on — instead of only ever seeing the rare priced outlier. Gated to
      // "completed" auctions: an in-progress draft would otherwise mark every
      // not-yet-picked player as undrafted.
      if (auction.status === 'completed') {
        for (const season of seasonMap.values()) {
          const playerId = season.player_id as string;
          if (draftedPlayerIds.has(playerId)) continue;
          const positionRank = season.position_rank ?? 0;
          if (positionRank <= 0) continue;
          const player = season.expand?.player_id;
          const position = player?.position ?? '';
          if (!SYNTHESIZABLE_POSITIONS.has(position)) continue;
          yearRows.push({
            year,
            player_id: playerId,
            name: player?.name ?? '',
            position,
            rank: season.rank ?? 0,
            position_rank: positionRank,
            price: 0,
            source: 'undrafted',
          });
        }
      }

      return yearRows;
    })
  );
  for (const yearRows of perYear) rows.push(...yearRows);

  // 3. Imported history: value-only season rows (actual_auction_value > 0) for any
  //    year that has NO chosen official auction.
  const importedRows = await pb.collection('player_seasons').getFullList({
    filter: pb.filter('actual_auction_value > 0'),
    expand: 'player_id',
    requestKey: null,
  });
  for (const season of importedRows) {
    if (chosenByYear.has(season.year)) continue;
    const player = season.expand?.player_id;
    rows.push({
      year: season.year,
      player_id: season.player_id,
      name: player?.name ?? '',
      position: player?.position ?? '',
      rank: season.rank ?? 0,
      position_rank: season.position_rank ?? 0,
      price: season.actual_auction_value,
      source: 'imported',
    });
  }

  // 4. Outside-league boards: the same priced + undrafted construction as step
  //    2, tagged `external` so collectComps discounts them by externalWeight.
  //    Unlike our own auctions these may cover the year being drafted, which is
  //    the point — it is the only same-year market evidence that exists.
  const externalPerYear = await Promise.all(
    externalAuctions.map(async (auction) => {
      const year = auction.year as number;
      const [picks, seasonMap] = await Promise.all([
        pb.collection('draft_picks').getFullList({
          filter: pb.filter('auction_id = {:auctionId} && price > 0', { auctionId: auction.id }),
          expand: 'player_id',
          requestKey: null,
        }),
        buildSeasonMap(year),
      ]);

      const yearRows: HistoricalValue[] = [];
      const draftedPlayerIds = new Set<string>();
      for (const pick of picks) {
        const season = seasonMap.get(pick.player_id as string);
        if (!season) continue;
        const player = pick.expand?.player_id;
        yearRows.push({
          year,
          player_id: pick.player_id,
          name: player?.name ?? '',
          position: player?.position ?? '',
          rank: season.rank ?? 0,
          position_rank: season.position_rank ?? 0,
          price: pick.price,
          source: 'external',
          external: true,
        });
        draftedPlayerIds.add(pick.player_id as string);
      }

      if (auction.status === 'completed') {
        for (const season of seasonMap.values()) {
          const playerId = season.player_id as string;
          if (draftedPlayerIds.has(playerId)) continue;
          const positionRank = season.position_rank ?? 0;
          if (positionRank <= 0) continue;
          const player = season.expand?.player_id;
          const position = player?.position ?? '';
          if (!SYNTHESIZABLE_POSITIONS.has(position)) continue;
          yearRows.push({
            year,
            player_id: playerId,
            name: player?.name ?? '',
            position,
            rank: season.rank ?? 0,
            position_rank: positionRank,
            price: 0,
            source: 'external',
            external: true,
          });
        }
      }

      return yearRows;
    })
  );
  for (const yearRows of externalPerYear) rows.push(...yearRows);

  return rows;
}
