'use client';

import { useRef } from 'react';
import { useLeagueContext } from '@/contexts/league-context';
import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { createAuction, completeAuction, deleteAuction, replaceAuction } from '@/server/actions/auctions';
import { Auction, CreateAuctionInput, ReplaceAuctionResolution } from '@/server/types/auction';
import { useAuction } from '@/contexts/auction-context';
import { useNavigation } from '@/contexts/navigation-context';

// The invalidated ['auctions'] refetch lands a tick after the mutation resolves.
// Selecting an id the cache doesn't hold yet would flash the "no active draft"
// landing on the way into the new draft room, so seed the record first.
function seedNewAuction(queryClient: QueryClient, newAuction: Auction) {
  queryClient.setQueryData<Auction[]>(['auctions', newAuction.league], (old) =>
    old ? [newAuction, ...old.filter((a) => a.id !== newAuction.id)] : [newAuction]
  );
  queryClient.invalidateQueries({ queryKey: ['auctions'] });
  queryClient.invalidateQueries({ queryKey: ['league-live-draft-counts'] });
}

export function useCreateAuction() {
  const queryClient = useQueryClient();
  const { enterDraftRoom } = useNavigation();
  const { selectedLeagueId } = useLeagueContext();
  const currentLeagueId = useRef(selectedLeagueId);
  currentLeagueId.current = selectedLeagueId;

  return useMutation({
    mutationFn: (input: CreateAuctionInput) => createAuction(input),
    onSuccess: (newAuction) => {
      seedNewAuction(queryClient, newAuction);
      queryClient.invalidateQueries({ queryKey: ['historical-values'] });
      queryClient.invalidateQueries({ queryKey: ['computed-profiles'] });
      // A request started in A may finish after the user switches to B.
      // Refresh A's cache, but never navigate them back out of B.
      if (currentLeagueId.current === newAuction.league) {
        enterDraftRoom(newAuction.id, newAuction.league);
      }
    },
    onError: () => {
      queryClient.invalidateQueries({ queryKey: ['auctions'] });
      queryClient.invalidateQueries({ queryKey: ['league-live-draft-counts'] });
    },
  });
}

export function useReplaceAuction() {
  const queryClient = useQueryClient();
  const { enterDraftRoom } = useNavigation();
  const { selectedLeagueId } = useLeagueContext();
  const currentLeagueId = useRef(selectedLeagueId);
  currentLeagueId.current = selectedLeagueId;

  return useMutation({
    mutationFn: ({ activeId, input, resolution }: {
      activeId: string;
      input: CreateAuctionInput;
      resolution: ReplaceAuctionResolution;
    }) => replaceAuction(activeId, input, resolution),
    onSuccess: (newAuction, { activeId, resolution }) => {
      queryClient.removeQueries({ queryKey: ['draft-picks', activeId] });
      queryClient.removeQueries({ queryKey: ['fantasy-teams', 'auction', activeId] });
      seedNewAuction(queryClient, newAuction);
      if (resolution === 'complete') {
        queryClient.invalidateQueries({ queryKey: ['historical-values'] });
        queryClient.invalidateQueries({ queryKey: ['computed-profiles'] });
      }
      // A request started in A may finish after the user switches to B.
      // Refresh A's cache, but never navigate them back out of B.
      if (currentLeagueId.current === newAuction.league) {
        enterDraftRoom(newAuction.id, newAuction.league);
      }
    },
    onError: () => {
      queryClient.invalidateQueries({ queryKey: ['auctions'] });
      queryClient.invalidateQueries({ queryKey: ['league-live-draft-counts'] });
    },
  });
}

export function useCompleteAuction() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => completeAuction(id),
    onSuccess: () => {
      // The selection is deliberately left alone: a completed draft stays
      // selected and `useCompletedDraftRedirect` moves anyone viewing it to the
      // read-only archive of that same draft.
      queryClient.invalidateQueries({ queryKey: ['auctions'] });
      queryClient.invalidateQueries({ queryKey: ['league-live-draft-counts'] });
      // A completed official auction's prices become historical data.
      queryClient.invalidateQueries({ queryKey: ['historical-values'] });
      queryClient.invalidateQueries({ queryKey: ['computed-profiles'] });
    },
  });
}

export function useDeleteAuction() {
  const queryClient = useQueryClient();
  const { selectedAuctionId, setSelectedAuctionId } = useAuction();

  return useMutation({
    mutationFn: (id: string) => deleteAuction(id),
    onSuccess: (_, deletedId) => {
      if (selectedAuctionId === deletedId) setSelectedAuctionId(null);
      queryClient.removeQueries({ queryKey: ['draft-picks', deletedId] });
      queryClient.removeQueries({ queryKey: ['fantasy-teams', 'auction', deletedId] });
      queryClient.invalidateQueries({ queryKey: ['historical-values'] });
      queryClient.invalidateQueries({ queryKey: ['computed-profiles'] });
      queryClient.invalidateQueries({ queryKey: ['auctions'] });
      queryClient.invalidateQueries({ queryKey: ['league-live-draft-counts'] });
    },
  });
}
