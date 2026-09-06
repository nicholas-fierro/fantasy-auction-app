'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { RecordModel } from 'pocketbase';
import { toast } from 'sonner';
import { pb } from '@/lib/pb-client';
import { mapPickRecord, ensureSeasonMap } from '@/lib/pb-mappers';
import { CreateDraftPick, DraftPickWithDetails } from '@/server/types/draft-pick';
import { useAuction } from '@/contexts/auction-context';
import { useLeague } from '@/hooks/use-league';

export function useAllDraftPicks() {
  const queryClient = useQueryClient();
  const { selectedAuctionId, selectedYear } = useAuction();
  const { settings } = useLeague();
  const scoringFormat = settings.scoringFormat;

  return useQuery({
    queryKey: ['draft-picks', selectedAuctionId, scoringFormat],
    queryFn: async () => {
      // Picks query and the shared season-map run in parallel.
      const [records, seasonByPlayerId] = await Promise.all([
        pb.collection('draft_picks').getFullList({
          filter: pb.filter('auction_id = {:auctionId}', { auctionId: selectedAuctionId }),
          sort: 'pick_order',
          expand: 'player_id,fantasy_team_id',
          requestKey: null,
        }),
        ensureSeasonMap(queryClient, selectedYear),
      ]);
      return records.map(record => mapPickRecord(record, scoringFormat, seasonByPlayerId.get(record.player_id)));
    },
    enabled: !!selectedAuctionId,
  });
}

export function useDraftPick(id: string) {
  const queryClient = useQueryClient();
  const { settings } = useLeague();
  const scoringFormat = settings.scoringFormat;

  return useQuery({
    queryKey: ['draft-pick', id, scoringFormat],
    queryFn: async () => {
      const record = await pb.collection('draft_picks').getOne(id, {
        expand: 'player_id,fantasy_team_id',
      });
      const auction = await pb.collection('auctions').getOne(record.auction_id);
      const year = auction.year || null;
      let season: RecordModel | undefined;
      if (year != null && record.player_id) {
        const seasonMap = await ensureSeasonMap(queryClient, year);
        season = seasonMap.get(record.player_id);
      }
      return mapPickRecord(record, scoringFormat, season);
    },
    enabled: !!id,
  });
}

export function useDraftPicksByTeam(teamId: string) {
  const queryClient = useQueryClient();
  const { selectedAuctionId, selectedYear } = useAuction();
  const { settings } = useLeague();
  const scoringFormat = settings.scoringFormat;

  return useQuery({
    queryKey: ['draft-picks', selectedAuctionId, scoringFormat, 'team', teamId],
    queryFn: async () => {
      const [records, seasonByPlayerId] = await Promise.all([
        pb.collection('draft_picks').getFullList({
          filter: pb.filter('auction_id = {:auctionId} && fantasy_team_id = {:teamId}', {
            auctionId: selectedAuctionId,
            teamId,
          }),
          sort: 'pick_order',
          expand: 'player_id,fantasy_team_id',
          requestKey: null,
        }),
        ensureSeasonMap(queryClient, selectedYear),
      ]);
      return records.map(record => mapPickRecord(record, scoringFormat, seasonByPlayerId.get(record.player_id)));
    },
    enabled: !!selectedAuctionId && !!teamId,
  });
}

export function useCreateDraftPick() {
  const queryClient = useQueryClient();
  // Picks go into the SELECTED auction (which isReadOnly guarantees is active),
  // not the user's own activeAuction — a league member recording their pick in
  // the commissioner's live official draft doesn't own that auction.
  const { selectedAuction, isReadOnly } = useAuction();
  const { settings } = useLeague();
  const scoringFormat = settings.scoringFormat;

  return useMutation({
    mutationFn: async (values: Omit<CreateDraftPick, 'auction_id'>): Promise<DraftPickWithDetails> => {
      if (isReadOnly || !selectedAuction) {
        throw new Error('Cannot draft into a completed auction');
      }
      const auctionId = selectedAuction.id;

      // pick_order is assigned server-side by the PocketBase hook
      // (pb_hooks/draft_picks_pick_order.pb.js) so concurrent writers (admin +
      // team members) can't race. If two creates do collide, the loser fails on
      // the (auction_id, pick_order) unique index — retry so the hook picks the
      // next free slot.
      const payload = {
        auction_id: auctionId,
        fantasy_team_id: values.fantasy_team_id,
        player_id: values.player_id,
        price: values.price ?? null,
        drafted_at: new Date().toISOString(),
      };
      let record: RecordModel;
      try {
        record = await pb.collection('draft_picks').create(payload, {
          expand: 'player_id,fantasy_team_id',
          requestKey: null,
        });
      } catch (error) {
        const fieldErrors = (error as { response?: { data?: Record<string, unknown> } }).response?.data;
        const isOrderCollision = !!fieldErrors && 'pick_order' in fieldErrors;
        if (!isOrderCollision) throw error;
        record = await pb.collection('draft_picks').create(payload, {
          expand: 'player_id,fantasy_team_id',
          requestKey: null,
        });
      }

      const year = selectedAuction.year;
      let season: RecordModel | undefined;
      if (year != null && record.player_id) {
        season = (await ensureSeasonMap(queryClient, year)).get(record.player_id);
      }
      return mapPickRecord(record, scoringFormat, season);
    },
    onSuccess: (newDraftPick) => {
      const auctionId = newDraftPick.auction_id;

      // The realtime subscription's create event can beat the HTTP response
      // (both come from the same server), so the pick may already be in the
      // list caches — upsert by id instead of appending.
      const upsertPick = (oldData: DraftPickWithDetails[] | undefined): DraftPickWithDetails[] => {
        if (!oldData) return [newDraftPick];
        if (oldData.some(pick => pick.id === newDraftPick.id)) {
          return oldData.map(pick => (pick.id === newDraftPick.id ? newDraftPick : pick));
        }
        return [...oldData, newDraftPick].sort((a, b) => a.pick_order - b.pick_order);
      };

      // Update the individual draft pick cache
      queryClient.setQueryData(['draft-pick', newDraftPick.id, scoringFormat], newDraftPick);

      // Update the all draft picks cache
      queryClient.setQueryData(['draft-picks', auctionId, scoringFormat], upsertPick);

      // Update the team-specific draft picks cache
      queryClient.setQueryData(
        ['draft-picks', auctionId, scoringFormat, 'team', newDraftPick.fantasy_team_id],
        upsertPick
      );
    },
    onError: (error) => {
      console.error('Failed to create draft pick:', error);
      toast.error("Couldn't save this draft pick — try again");
    },
  });
}

export function useUpdateDraftPickPrice() {
  const queryClient = useQueryClient();
  const { isReadOnly, selectedYear } = useAuction();
  const { settings } = useLeague();
  const scoringFormat = settings.scoringFormat;

  return useMutation({
    mutationFn: async ({ id, price }: { id: string; price: number | null }): Promise<DraftPickWithDetails> => {
      if (isReadOnly) {
        throw new Error('Cannot edit prices in a completed auction');
      }
      // The API rule enforces ownership + active status on update.
      const record = await pb.collection('draft_picks').update(id, { price }, {
        expand: 'player_id,fantasy_team_id',
      });
      // Priced picks belong to the selected (active) auction, so its year hydrates
      // the season stats.
      let season: RecordModel | undefined;
      if (record.player_id) {
        season = (await ensureSeasonMap(queryClient, selectedYear)).get(record.player_id);
      }
      return mapPickRecord(record, scoringFormat, season);
    },
    onMutate: async ({ id, price }) => {
      await queryClient.cancelQueries({ queryKey: ['draft-picks'] });
      await queryClient.cancelQueries({ queryKey: ['draft-pick', id, scoringFormat] });

      // Snapshot every draft-picks list (all + per-team) so we can roll back,
      // then patch just the affected pick's price by id in each.
      const previousDraftPicksQueries = queryClient.getQueriesData<DraftPickWithDetails[]>({ queryKey: ['draft-picks'] });
      const previousDraftPick = queryClient.getQueryData<DraftPickWithDetails>(['draft-pick', id, scoringFormat]);

      queryClient.setQueriesData<DraftPickWithDetails[] | undefined>(
        { queryKey: ['draft-picks'] },
        (oldData) => {
          if (!oldData) return oldData;
          return oldData.map(pick => pick.id === id ? { ...pick, price } : pick);
        }
      );

      queryClient.setQueryData<DraftPickWithDetails | undefined>(['draft-pick', id, scoringFormat], (oldData) => {
        if (!oldData) return oldData;
        return { ...oldData, price };
      });

      return { previousDraftPicksQueries, previousDraftPick };
    },
    onError: (_err, variables, context) => {
      context?.previousDraftPicksQueries?.forEach(([queryKey, data]) => {
        queryClient.setQueryData(queryKey, data);
      });
      if (context?.previousDraftPick !== undefined) {
        queryClient.setQueryData(['draft-pick', variables.id, scoringFormat], context.previousDraftPick);
      }
    },
    onSuccess: (updatedPick) => {
      const auctionId = updatedPick.auction_id;

      queryClient.setQueryData(['draft-pick', updatedPick.id, scoringFormat], updatedPick);

      queryClient.setQueryData(['draft-picks', auctionId, scoringFormat], (oldData: DraftPickWithDetails[] | undefined) => {
        if (!oldData) return oldData;
        return oldData.map(pick => pick.id === updatedPick.id ? updatedPick : pick);
      });
    },
  });
}

export function useDeleteDraftPick() {
  const queryClient = useQueryClient();
  const { selectedAuctionId, isReadOnly } = useAuction();
  const { settings } = useLeague();
  const scoringFormat = settings.scoringFormat;

  return useMutation({
    mutationFn: async (id: string) => {
      if (isReadOnly) {
        throw new Error('Cannot delete picks from a completed auction');
      }
      // The API rule enforces ownership + active status on delete.
      await pb.collection('draft_picks').delete(id);
    },
    onMutate: async (deletedId) => {
      await queryClient.cancelQueries({ queryKey: ['draft-picks', selectedAuctionId, scoringFormat] });

      const previousAllPicks = queryClient.getQueryData<DraftPickWithDetails[]>(['draft-picks', selectedAuctionId, scoringFormat]);
      const previousTeamPicksQueries = queryClient.getQueriesData<DraftPickWithDetails[]>({
        queryKey: ['draft-picks', selectedAuctionId, scoringFormat, 'team'],
      });

      // Update the all draft picks cache
      queryClient.setQueryData(['draft-picks', selectedAuctionId, scoringFormat], (oldData: DraftPickWithDetails[] | undefined) => {
        if (!oldData) return oldData;
        return oldData.filter(pick => pick.id !== deletedId);
      });

      // Update all team-specific caches for this auction
      queryClient.setQueriesData(
        { queryKey: ['draft-picks', selectedAuctionId, scoringFormat, 'team'] },
        (oldData: DraftPickWithDetails[] | undefined) => {
          if (!oldData) return oldData;
          return oldData.filter(pick => pick.id !== deletedId);
        }
      );

      return { previousAllPicks, previousTeamPicksQueries };
    },
    onError: (_err, _deletedId, context) => {
      if (context?.previousAllPicks !== undefined) {
        queryClient.setQueryData(['draft-picks', selectedAuctionId, scoringFormat], context.previousAllPicks);
      }
      context?.previousTeamPicksQueries?.forEach(([queryKey, data]) => {
        queryClient.setQueryData(queryKey, data);
      });
    },
    onSuccess: (_, deletedId) => {
      // Remove from individual cache
      queryClient.removeQueries({ queryKey: ['draft-pick', deletedId] });
    },
  });
}
