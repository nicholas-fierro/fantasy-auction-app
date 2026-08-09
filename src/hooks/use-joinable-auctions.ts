'use client';

import { pb } from '@/lib/pb-client';
import { useAuction } from '@/contexts/auction-context';
import { Auction } from '@/server/types/auction';

// 3a: active official auctions the signed-in user can read (league-member
// visibility, AD-18) that aren't the one currently selected — i.e. a live
// draft they could switch into. Derived from the auctions list AuctionProvider
// already fetches (AD-11: no extra query). The auction's own owner never
// needs this nudge — they're already looking at it (or chose not to be).
export function useJoinableAuctions(): Auction[] {
  const { auctions, selectedAuctionId } = useAuction();
  const userId = pb.authStore.record?.id ?? null;

  return auctions.filter(
    (auction) =>
      auction.status === 'active' &&
      auction.type === 'official' &&
      auction.id !== selectedAuctionId &&
      (!userId || auction.user !== userId),
  );
}
