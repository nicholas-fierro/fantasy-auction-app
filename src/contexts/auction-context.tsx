'use client';

import { createContext, useCallback, useContext, useEffect, useState, useMemo, ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { pb } from '@/lib/pb-client';
import { mapAuctionRecord } from '@/lib/pb-mappers';
import { useLeagueContext } from '@/contexts/league-context';
import { Auction } from '@/server/types/auction';

interface AuctionContextType {
  auctions: Auction[];
  accessibleActiveAuctions: Auction[];
  selectedAuction: Auction | null;
  selectedAuctionId: string | null;
  setSelectedAuctionId: (id: string | null, leagueId?: string | null) => void;
  forgetSelectedAuctionId: () => void;
  selectedYear: number;
  activeAuction: Auction | null;
  isReadOnly: boolean;
  isLoading: boolean;
}

const AuctionContext = createContext<AuctionContextType | undefined>(undefined);

// Survives a reload so refreshing returns you to the draft you were viewing
// rather than whichever owned active draft happens to sort first.
const SELECTED_AUCTION_KEY = 'selected-auction-id';

export function AuctionProvider({ children }: { children: ReactNode }) {
  const {
    selectedLeagueId,
    setSelectedLeagueId,
    isLoading: leagueLoading,
  } = useLeagueContext();
  const [explicitAuctionId, setExplicitAuctionId] = useState<string | null>(null);

  // Restored in an effect, not a lazy initializer: reading storage during the
  // first render would diverge from the prerendered HTML and break hydration.
  useEffect(() => {
    const saved = localStorage.getItem(SELECTED_AUCTION_KEY);
    if (saved) setExplicitAuctionId(saved);
  }, []);

  const { data: allAuctions = [], isLoading: auctionsLoading } = useQuery({
    queryKey: ['auctions', selectedLeagueId],
    queryFn: async () => {
      if (!selectedLeagueId) return [];
      const records = await pb.collection('auctions').getFullList({
        sort: '-drafted_at,-created',
        filter: pb.filter('league = {:leagueId} && external != true', { leagueId: selectedLeagueId }),
      });
      return records.filter((record) => record.external !== true).map(mapAuctionRecord);
    },
    enabled: !!selectedLeagueId,
  });

  // Also guard cached data: a late write must never expose another league's draft.
  const auctions = useMemo(
    () => allAuctions.filter(auction => auction.league === selectedLeagueId),
    [allAuctions, selectedLeagueId],
  );

  const setSelectedAuctionId = useCallback((
    id: string | null,
    leagueId?: string | null,
  ) => {
    if (id) {
      const auction = allAuctions.find(candidate => candidate.id === id);
      const targetLeagueId = leagueId ?? auction?.league ?? null;
      if (targetLeagueId) {
        setSelectedLeagueId(targetLeagueId);
      } else if (process.env.NODE_ENV !== 'production') {
        console.assert(auction, `Cannot select unknown auction ${id}`);
      }
    }
    setExplicitAuctionId(id);
  }, [allAuctions, setSelectedLeagueId]);

  const forgetSelectedAuctionId = useCallback(() => {
    setExplicitAuctionId(null);
    localStorage.removeItem(SELECTED_AUCTION_KEY);
  }, []);

  // Active drafts this user may enter. The `auctions` list rule also hands a
  // commissioner every league member's private mock, so entering is restricted
  // to official drafts plus the user's own — the rule grants read access for
  // oversight, not a seat in someone else's mock.
  const userId = pb.authStore.record?.id ?? null;
  const accessibleActiveAuctions = useMemo(
    () => auctions.filter(auction =>
      auction.status === 'active' && (auction.type === 'official' || auction.user === userId)
    ),
    [auctions, userId],
  );

  // The signed-in user's owned active draft used as the default selection.
  // One active draft per type is a lifecycle invariant, not a uniqueness proof;
  // official and mock drafts may coexist.
  const activeAuction =
    accessibleActiveAuctions.find(auction => !userId || auction.user === userId) ?? null;

  // Follow the default owned active draft until the user explicitly chooses
  // another one. A persisted auction from another league is ignored.
  const explicitAuction = auctions.find(auction => auction.id === explicitAuctionId) ?? null;
  const selectedAuction = explicitAuction ?? activeAuction;

  // Pin the default the moment it resolves. Leaving it derived would evaporate
  // the selection the instant that draft stops being active — dropping whoever
  // was watching onto the landing page instead of the finished board.
  useEffect(() => {
    if (!explicitAuction && activeAuction) setSelectedAuctionId(activeAuction.id);
  }, [explicitAuction, activeAuction, setSelectedAuctionId]);

  // Only persist a real selection — clearing it (going home, deleting a draft)
  // shouldn't erase where to return to on the next reload.
  useEffect(() => {
    if (explicitAuctionId) localStorage.setItem(SELECTED_AUCTION_KEY, explicitAuctionId);
  }, [explicitAuctionId]);

  useEffect(() => {
    if (
      process.env.NODE_ENV !== 'production' &&
      selectedAuction?.league &&
      selectedLeagueId &&
      selectedAuction.league !== selectedLeagueId
    ) {
      throw new Error(
        `Selected auction ${selectedAuction.id} belongs to league ${selectedAuction.league}, not ${selectedLeagueId}`,
      );
    }
  }, [selectedAuction, selectedLeagueId]);

  const selectedAuctionId = selectedAuction?.id ?? null;
  const selectedYear = selectedAuction?.year ?? new Date().getFullYear();
  const isReadOnly = selectedAuction !== null && selectedAuction.status !== 'active';
  const isLoading = leagueLoading || (!!selectedLeagueId && auctionsLoading);

  const value = useMemo(() => ({
    auctions,
    accessibleActiveAuctions,
    selectedAuction,
    selectedAuctionId,
    setSelectedAuctionId,
    forgetSelectedAuctionId,
    selectedYear,
    activeAuction,
    isReadOnly,
    isLoading,
  }), [
    auctions,
    accessibleActiveAuctions,
    selectedAuction,
    selectedAuctionId,
    setSelectedAuctionId,
    forgetSelectedAuctionId,
    selectedYear,
    activeAuction,
    isReadOnly,
    isLoading,
  ]);

  return (
    <AuctionContext.Provider value={value}>
      {children}
    </AuctionContext.Provider>
  );
}

export function useAuction() {
  const context = useContext(AuctionContext);
  if (context === undefined) {
    throw new Error('useAuction must be used within an AuctionProvider');
  }
  return context;
}
