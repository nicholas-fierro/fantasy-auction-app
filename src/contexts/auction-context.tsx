'use client';

import { createContext, useContext, useEffect, useState, useMemo, ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { pb } from '@/lib/pb-client';
import { mapAuctionRecord } from '@/lib/pb-mappers';
import { Auction } from '@/server/types/auction';

interface AuctionContextType {
  auctions: Auction[];
  accessibleActiveAuctions: Auction[];
  selectedAuction: Auction | null;
  selectedAuctionId: string | null;
  setSelectedAuctionId: (id: string | null) => void;
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
  const [explicitAuctionId, setSelectedAuctionId] = useState<string | null>(null);

  // Restored in an effect, not a lazy initializer: reading storage during the
  // first render would diverge from the prerendered HTML and break hydration.
  useEffect(() => {
    const saved = localStorage.getItem(SELECTED_AUCTION_KEY);
    if (saved) setSelectedAuctionId(saved);
  }, []);

  const { data: auctions = [], isLoading } = useQuery({
    queryKey: ['auctions'],
    queryFn: async () => {
      // Auth-scoped by the `auctions` API rule (user = @request.auth.id).
      const records = await pb.collection('auctions').getFullList({
        sort: '-drafted_at,-created',
      });
      // Outside-league boards are readable so the value model can price off
      // them (migration 1784380000), but they are not this league's drafts:
      // they must never appear in the auction picker, be selectable, or be
      // mistaken for an official draft anyone can enter.
      return records.filter((record) => record.external !== true).map(mapAuctionRecord);
    },
  });

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
  // another one. The selection survives that draft completing — it becomes
  // read-only history in place (`useCompletedDraftRedirect` moves the view).
  const explicitAuction = auctions.find(auction => auction.id === explicitAuctionId) ?? null;
  const selectedAuction = explicitAuction ?? activeAuction;

  // Pin the default the moment it resolves. Leaving it derived would evaporate
  // the selection the instant that draft stops being active — dropping whoever
  // was watching onto the landing page instead of the finished board.
  useEffect(() => {
    if (!explicitAuctionId && activeAuction) setSelectedAuctionId(activeAuction.id);
  }, [explicitAuctionId, activeAuction]);

  // Only persist a real selection — clearing it (going home, deleting a draft)
  // shouldn't erase where to return to on the next reload.
  useEffect(() => {
    if (explicitAuctionId) localStorage.setItem(SELECTED_AUCTION_KEY, explicitAuctionId);
  }, [explicitAuctionId]);

  const selectedAuctionId = selectedAuction?.id ?? null;
  const selectedYear = selectedAuction?.year ?? new Date().getFullYear();
  const isReadOnly = selectedAuction !== null && selectedAuction.status !== 'active';

  const value = useMemo(() => ({
    auctions,
    accessibleActiveAuctions,
    selectedAuction,
    selectedAuctionId,
    setSelectedAuctionId,
    selectedYear,
    activeAuction,
    isReadOnly,
    isLoading,
  }), [auctions, accessibleActiveAuctions, selectedAuction, selectedAuctionId, setSelectedAuctionId, selectedYear, activeAuction, isReadOnly, isLoading]);

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
