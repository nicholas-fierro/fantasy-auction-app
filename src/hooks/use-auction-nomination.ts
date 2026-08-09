'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RecordModel } from 'pocketbase';
import { toast } from 'sonner';
import { useAuction } from '@/contexts/auction-context';
import { newerNominationEvent } from '@/lib/active-nomination';
import { pb } from '@/lib/pb-client';
import {
  AuctionNominationAction,
  AuctionNominationEvent,
} from '@/server/types/auction-nomination';

export const auctionNominationQueryKey = (auctionId: string | null) =>
  ['auction-nomination', auctionId] as const;

export function mapAuctionNominationEvent(record: RecordModel): AuctionNominationEvent {
  return {
    id: record.id,
    auction_id: record.auction_id,
    player_id: record.player_id || null,
    user: record.user,
    action: record.action,
    event_order: record.event_order,
    pick_count: record.pick_count,
    created: record.created,
  };
}

export function useLatestAuctionNomination() {
  const { selectedAuction } = useAuction();
  const auctionId = selectedAuction?.id ?? null;
  const isOfficial = selectedAuction?.type === 'official';

  return useQuery({
    queryKey: auctionNominationQueryKey(auctionId),
    queryFn: async (): Promise<AuctionNominationEvent | null> => {
      const page = await pb.collection('auction_nomination_events').getList(1, 1, {
        filter: pb.filter('auction_id = {:auctionId}', { auctionId }),
        sort: '-event_order',
        requestKey: null,
      });
      return page.items[0] ? mapAuctionNominationEvent(page.items[0]) : null;
    },
    enabled: !!auctionId && isOfficial,
  });
}

export const auctionNominationHistoryQueryKey = (auctionId: string | null) =>
  ['auction-nomination', auctionId, 'history'] as const;

// Full ordered nomination/clear stream for the selected official auction, used
// by the draft activity log (3e). Kept under the same ['auction-nomination', …]
// key prefix so a reconnect resync (3b) invalidates it too. Realtime create
// events append here so the log stays live without a refetch.
export function useAuctionNominationHistory() {
  const { selectedAuction } = useAuction();
  const auctionId = selectedAuction?.id ?? null;
  const isOfficial = selectedAuction?.type === 'official';

  return useQuery({
    queryKey: auctionNominationHistoryQueryKey(auctionId),
    queryFn: async (): Promise<AuctionNominationEvent[]> => {
      const records = await pb.collection('auction_nomination_events').getFullList({
        filter: pb.filter('auction_id = {:auctionId}', { auctionId }),
        sort: '-event_order',
        requestKey: null,
      });
      return records.map(mapAuctionNominationEvent);
    },
    enabled: !!auctionId && isOfficial,
  });
}

export function useCreateAuctionNominationEvent() {
  const queryClient = useQueryClient();
  const { selectedAuction, isReadOnly } = useAuction();

  return useMutation({
    mutationFn: async ({
      action,
      playerId,
    }: {
      action: AuctionNominationAction;
      playerId: string | null;
    }): Promise<AuctionNominationEvent> => {
      if (!selectedAuction || selectedAuction.type !== 'official' || isReadOnly) {
        throw new Error('Shared nominations require an active official auction');
      }
      const userId = pb.authStore.record?.id;
      if (!userId) throw new Error('You must be signed in to nominate a player');

      const payload = {
        auction_id: selectedAuction.id,
        player_id: playerId,
        user: userId,
        action,
      };
      let record: RecordModel;
      try {
        record = await pb.collection('auction_nomination_events').create(payload, {
          requestKey: null,
        });
      } catch (error) {
        const fieldErrors = (error as { response?: { data?: Record<string, unknown> } }).response?.data;
        const isOrderCollision = !!fieldErrors && 'event_order' in fieldErrors;
        if (!isOrderCollision) throw error;
        record = await pb.collection('auction_nomination_events').create(payload, {
          requestKey: null,
        });
      }
      return mapAuctionNominationEvent(record);
    },
    onSuccess: (event) => {
      queryClient.setQueryData<AuctionNominationEvent | null>(
        auctionNominationQueryKey(event.auction_id),
        (current) => newerNominationEvent(current, event),
      );
    },
    onError: (error) => {
      console.error('Failed to sync auction nomination:', error);
      toast.error("Couldn't sync your nomination — try again");
    },
  });
}
