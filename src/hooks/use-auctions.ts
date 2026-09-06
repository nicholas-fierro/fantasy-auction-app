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

// History and profiles are keyed per league — invalidating the affected league
// only keeps sibling leagues' cached history intact. An unknown league falls
// back to the unkeyed prefix form rather than missing the update.
function invalidateLeagueHistory(queryClient: QueryClient, leagueId: string | null) {
  const historyKey = leagueId ? ['historical-values', leagueId] : ['historical-values'];
  const profilesKey = leagueId ? ['computed-profiles', leagueId] : ['computed-profiles'];
  queryClient.invalidateQueries({ queryKey: historyKey });
  queryClient.invalidateQueries({ queryKey: profilesKey });
}

function leagueIdForAuction(queryClient: QueryClient, auctionId: string): string | null {
  const cached = queryClient.getQueriesData<Auction[]>({ queryKey: ['auctions'] });
  for (const [, auctions] of cached) {
    const match = auctions?.find((auction) => auction.id === auctionId);
    if (match) return match.league;
  }
  return null;
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
      invalidateLeagueHistory(queryClient, newAuction.league);
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
        invalidateLeagueHistory(queryClient, newAuction.league);
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
    onSuccess: (completed) => {
      // The selection is deliberately left alone: a completed draft stays
      // selected and `useCompletedDraftRedirect` moves anyone viewing it to the
      // read-only archive of that same draft.
      queryClient.invalidateQueries({ queryKey: ['auctions'] });
      queryClient.invalidateQueries({ queryKey: ['league-live-draft-counts'] });
      // A completed official auction's prices become historical data.
      invalidateLeagueHistory(queryClient, completed.league);
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
      invalidateLeagueHistory(queryClient, leagueIdForAuction(queryClient, deletedId));
      queryClient.invalidateQueries({ queryKey: ['auctions'] });
      queryClient.invalidateQueries({ queryKey: ['league-live-draft-counts'] });
    },
  });
}
