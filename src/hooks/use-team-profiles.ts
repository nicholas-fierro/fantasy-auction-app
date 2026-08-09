'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { RecordModel } from 'pocketbase';
import { pb } from '@/lib/pb-client';
import { computeHistoricalValues, chosenAuctionsByYear } from '@/lib/history-client';
import { buildHistoryIndex, estimateValue } from '@/lib/estimated-value';
import { computeTeamProfiles, ProfilePick } from '@/lib/mock-draft/profiles';
import { TeamProfile } from '@/lib/mock-draft/types';

// Computed from league history only; there is no manual override layer (AD-27).
// Priced official-auction picks drive auction stats, $0 snake-round picks drive
// snake stats, and both drive NFL-team and rookie leanings. The result changes
// only with official history, so it is cached like historical values.
export function useTeamProfiles() {
  const queryClient = useQueryClient();

  return useQuery({
    queryKey: ['computed-profiles'],
    staleTime: 1000 * 60 * 60, // 1 hour
    queryFn: async (): Promise<Map<string, TeamProfile>> => {
      // League value index (shared cache with useHistoricalValues).
      const historicalValues = await queryClient.ensureQueryData({
        queryKey: ['historical-values'],
        queryFn: computeHistoricalValues,
      });
      const index = buildHistoryIndex(historicalValues);

      const [teams, officialAuctions, allSeasonRows] = await Promise.all([
        pb.collection('fantasy_teams').getFullList({ requestKey: null }),
        pb.collection('auctions').getFullList({
          filter: pb.filter('type = "official" && year > 0'),
          requestKey: null,
        }),
        // Every season row in one request rather than one per year: the rookie guard
        // below needs to see a player's earlier years, not just the pick's year.
        pb.collection('player_seasons').getFullList({ requestKey: null }),
      ]);
      const teamIds = teams.map((t) => t.id as string);

      const seasonsByYear = new Map<number, Map<string, RecordModel>>();
      // Earliest season row per player — a player already ranked or drafted in an
      // earlier year is definitively not a rookie now.
      const firstSeasonYear = new Map<string, number>();
      for (const row of allSeasonRows) {
        const year = row.year as number;
        const playerId = row.player_id as string;
        let forYear = seasonsByYear.get(year);
        if (!forYear) {
          forYear = new Map<string, RecordModel>();
          seasonsByYear.set(year, forYear);
        }
        forYear.set(playerId, row);
        const earliest = firstSeasonYear.get(playerId);
        if (earliest === undefined || year < earliest) firstSeasonYear.set(playerId, year);
      }

      // One chosen official auction per year.
      const chosenByYear = chosenAuctionsByYear(officialAuctions);

      const picksByTeam = new Map<string, ProfilePick[]>();

      await Promise.all(
        [...chosenByYear.entries()].map(async ([year, auction]) => {
          const picks = await pb.collection('draft_picks').getFullList({
            filter: pb.filter('auction_id = {:auctionId}', { auctionId: auction.id }),
            expand: 'player_id',
            requestKey: null,
          });
          const seasonMap = seasonsByYear.get(year) ?? new Map<string, RecordModel>();

          for (const pick of picks) {
            const player = pick.expand?.player_id;
            if (!player) continue;
            const playerId = pick.player_id as string;
            const season = seasonMap.get(playerId);
            const positionRank = (season?.position_rank as number) ?? 0;
            const rank = (season?.rank as number) ?? 0;
            const est = estimateValue(index, player.position, positionRank, rank, year);

            // `is_rookie` is only trustworthy in one direction. A `true` was either
            // hand-entered or derived by scripts/backfill-rookie-flags.ts, but a
            // `false` may just mean the backfill could not resolve the player (no
            // game logs — a rookie who never saw the field). Treating those as
            // confirmed veterans would depress every rookie rate, so a `false` only
            // counts when an earlier season row proves the player is not a rookie.
            const isRookie = season?.is_rookie === true;

            const teamId = pick.fantasy_team_id as string;
            const list = picksByTeam.get(teamId) ?? [];
            list.push({
              teamId,
              year,
              position: player.position,
              price: (pick.price as number) ?? 0,
              estimate: est?.estimate ?? 0,
              pickOrder: (pick.pick_order as number) ?? 0,
              rank,
              nflTeam: (season?.team as string) ?? '',
              isRookie,
              rookieDataKnown: isRookie || (firstSeasonYear.get(playerId) ?? year) < year,
            });
            picksByTeam.set(teamId, list);
          }
        })
      );

      return computeTeamProfiles(teamIds, picksByTeam);
    },
  });
}
