'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { pb } from '@/lib/pb-client';
import { mapWatchlistRecord, ensureSeasonMap } from '@/lib/pb-mappers';
import { Watchlist, WatchlistWithDetails, UpdateWatchlistOrderData } from '@/server/types/watchlist';
import { Player } from '@/server/types/player';
import { useAuction } from '@/contexts/auction-context';
import { useLeague } from '@/hooks/use-league';

export function useWatchlist() {
  const queryClient = useQueryClient();
  const { selectedYear } = useAuction();
  const { settings } = useLeague();
  const scoringFormat = settings.scoringFormat;

  return useQuery<WatchlistWithDetails[], Error>({
    queryKey: ['watchlist', selectedYear, scoringFormat],
    queryFn: async () => {
      // Rows are auth-scoped by the `watchlist` API rule (user = @request.auth.id).
      // The watchlist query and the shared season-map run in parallel; the season
      // map is shared with the draft-picks hook via ['player-seasons', year].
      const [records, seasonByPlayerId] = await Promise.all([
        pb.collection('watchlist').getFullList({
          expand: 'player_id',
          sort: '+watch_order',
          requestKey: null,
        }),
        ensureSeasonMap(queryClient, selectedYear),
      ]);
      return records.map(record =>
        mapWatchlistRecord(record, seasonByPlayerId.get(record.player_id), scoringFormat)
      );
    },
  });
}

export function useAddToWatchlist() {
  const queryClient = useQueryClient();
  const { selectedYear } = useAuction();
  const { settings } = useLeague();
  const scoringFormat = settings.scoringFormat;

  return useMutation({
    mutationFn: async (playerId: string): Promise<Watchlist> => {
      const userId = pb.authStore.record?.id;
      if (!userId) throw new Error('Not authenticated');

      // Append at the end; watch_order is assigned client-side. The API rule
      // scopes the max-order lookup and the create to this user.
      const existing = await pb.collection('watchlist').getList(1, 1, {
        sort: '-watch_order',
        requestKey: null,
      });
      const nextOrder = existing.items.length > 0 ? existing.items[0].watch_order + 1 : 1;

      const record = await pb.collection('watchlist').create({
        user: userId,
        player_id: playerId,
        watch_order: nextOrder,
      });
      return {
        id: record.id,
        user: record.user,
        player_id: record.player_id,
        watch_order: record.watch_order,
        market_nudge: 1,
        created: record.created,
        updated: record.updated,
      };
    },
    onMutate: async (playerId: string) => {
      await queryClient.cancelQueries({ queryKey: ['watchlist', selectedYear, scoringFormat] });

      const previousWatchlist = queryClient.getQueryData<WatchlistWithDetails[]>(['watchlist', selectedYear, scoringFormat]);

      // Look up the player's hydrated details so we can render an optimistic
      // row immediately; if it's not cached, skip the optimistic insert and
      // fall back to invalidation on success.
      const players = queryClient.getQueryData<Player[]>([
        'players',
        selectedYear,
        scoringFormat,
      ]);
      const player = players?.find(p => p.id === playerId);

      if (!player) {
        return { previousWatchlist, optimisticId: null as string | null };
      }

      const optimisticId = `optimistic-${playerId}`;
      const maxOrder = previousWatchlist?.reduce((max, item) => Math.max(max, item.watch_order), 0) ?? 0;
      const now = new Date().toISOString();

      const optimisticEntry: WatchlistWithDetails = {
        id: optimisticId,
        user: '',
        player_id: playerId,
        watch_order: maxOrder + 1,
        market_nudge: 1,
        created: now,
        updated: now,
        player,
      };

      queryClient.setQueryData<WatchlistWithDetails[]>(['watchlist', selectedYear, scoringFormat], (oldData) =>
        oldData ? [...oldData, optimisticEntry] : [optimisticEntry]
      );

      return { previousWatchlist, optimisticId };
    },
    onError: (_err, _playerId, context) => {
      if (context?.previousWatchlist !== undefined) {
        queryClient.setQueryData(['watchlist', selectedYear, scoringFormat], context.previousWatchlist);
      }
    },
    onSuccess: (newWatchlistRecord, _playerId, context) => {
      if (!context?.optimisticId) {
        // No optimistic row was inserted (player wasn't in cache) — refetch instead.
        queryClient.invalidateQueries({ queryKey: ['watchlist'] });
        return;
      }

      // Swap the temp id/watch_order for the server's, keeping the hydrated
      // player object from the optimistic entry (the server response has none).
      // The realtime subscription's create event can beat the HTTP response, in
      // which case the real record is already in the cache — then just drop the
      // optimistic row instead of swapping ids into a duplicate.
      queryClient.setQueryData<WatchlistWithDetails[]>(['watchlist', selectedYear, scoringFormat], (oldData) => {
        if (!oldData) return oldData;
        if (oldData.some(item => item.id === newWatchlistRecord.id)) {
          return oldData.filter(item => item.id !== context.optimisticId);
        }
        return oldData.map(item =>
          item.id === context.optimisticId
            ? { ...item, id: newWatchlistRecord.id, watch_order: newWatchlistRecord.watch_order }
            : item
        );
      });
    },
  });
}

export function useRemoveFromWatchlist() {
  const queryClient = useQueryClient();
  const { selectedYear } = useAuction();
  const { settings } = useLeague();
  const scoringFormat = settings.scoringFormat;

  return useMutation({
    mutationFn: async (watchlistId: string) => {
      // The API rule enforces ownership on delete.
      await pb.collection('watchlist').delete(watchlistId);
    },
    onMutate: async (watchlistId: string) => {
      await queryClient.cancelQueries({ queryKey: ['watchlist', selectedYear, scoringFormat] });

      const previousWatchlist = queryClient.getQueryData<WatchlistWithDetails[]>(['watchlist', selectedYear, scoringFormat]);

      queryClient.setQueryData<WatchlistWithDetails[]>(['watchlist', selectedYear, scoringFormat], (oldData) =>
        oldData ? oldData.filter(item => item.id !== watchlistId) : oldData
      );

      return { previousWatchlist };
    },
    onError: (_err, _watchlistId, context) => {
      if (context?.previousWatchlist !== undefined) {
        queryClient.setQueryData(['watchlist', selectedYear, scoringFormat], context.previousWatchlist);
      }
    },
  });
}

export function useUpdateWatchlistOrder() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (updates: UpdateWatchlistOrderData[]) => {
      // One transactional round trip; the API rule authorizes each row.
      const batch = pb.createBatch();
      for (const update of updates) {
        batch.collection('watchlist').update(update.id, { watch_order: update.watch_order });
      }
      await batch.send();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['watchlist'] });
    },
  });
}
