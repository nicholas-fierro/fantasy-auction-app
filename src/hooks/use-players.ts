'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { pb } from '@/lib/pb-client';
import { mapSeasonToPlayer, mapSeasonRecord } from '@/lib/pb-mappers';
import { Player, PlayerSeason, UpdatePlayerAuctionValues } from '@/server/types/player';
import { useAuction } from '@/contexts/auction-context';

export function useAllPlayers() {
  const { selectedYear } = useAuction();

  return useQuery({
    queryKey: ['players', selectedYear],
    queryFn: async () => {
      // Value-only history rows (imported price data with no ranking) have rank 0
      // and are excluded from the players table.
      const records = await pb.collection('player_seasons').getFullList({
        filter: pb.filter('year = {:year} && rank > 0', { year: selectedYear }),
        sort: 'rank',
        expand: 'player_id',
      });
      return records.map(mapSeasonToPlayer);
    },
  });
}

// All season rows for one player — powers the detail modal. Only fetched while
// the modal is open (`enabled`).
export function usePlayerSeasons(playerId: string, enabled = true) {
  return useQuery({
    queryKey: ['player-seasons', playerId],
    queryFn: async () => {
      const records = await pb.collection('player_seasons').getFullList({
        filter: pb.filter('player_id = {:playerId}', { playerId }),
        sort: '-year',
      });
      return records.map(mapSeasonRecord);
    },
    enabled: enabled && !!playerId,
  });
}

export function useUpdatePlayerAuctionValues() {
  const queryClient = useQueryClient();
  const { selectedYear } = useAuction();

  return useMutation({
    mutationFn: async ({ seasonId, values }: { seasonId: string; values: UpdatePlayerAuctionValues }) => {
      const record = await pb.collection('player_seasons').update(seasonId, values);
      return mapSeasonRecord(record);
    },
    onSuccess: (updatedSeason: PlayerSeason) => {
      // Patch the year-keyed players cache by matching season_id.
      queryClient.setQueryData(['players', selectedYear], (oldData: Player[] | undefined) => {
        if (!oldData) return oldData;
        return oldData.map(player =>
          player.season_id === updatedSeason.id
            ? { ...player, projected_auction_value: updatedSeason.projected_auction_value }
            : player
        );
      });
      queryClient.setQueryData(['player-seasons', updatedSeason.player_id], (oldData: PlayerSeason[] | undefined) =>
        oldData?.map(season => season.id === updatedSeason.id ? updatedSeason : season)
      );
    },
    onError: (error) => {
      console.error('Failed to update player auction values:', error);
    },
  });
}
