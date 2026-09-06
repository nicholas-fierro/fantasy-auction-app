'use client';

import { useEffect } from 'react';
import { RecordModel } from 'pocketbase';
import { useQueryClient } from '@tanstack/react-query';
import { pb } from '@/lib/pb-client';
import {
  mapPickRecord,
  mapWatchlistRecord,
  seasonRowsQueryKey,
  seasonMapFromRows,
} from '@/lib/pb-mappers';
import { useAuction } from '@/contexts/auction-context';
import { useLeague } from '@/hooks/use-league';
import {
  auctionNominationQueryKey,
  auctionNominationHistoryQueryKey,
  mapAuctionNominationEvent,
} from '@/hooks/use-auction-nomination';
import { newerNominationEvent } from '@/lib/active-nomination';
import { AuctionNominationEvent } from '@/server/types/auction-nomination';
import { DraftPickWithDetails } from '@/server/types/draft-pick';
import { WatchlistWithDetails } from '@/server/types/watchlist';

type RealtimeEvent = { action: string; record: RecordModel };

// Subscribes the selected auction's draft picks and nominations, plus the user's
// watchlist, to PocketBase realtime (a single SSE connection multiplexed by the
// shared client singleton) and patches the TanStack Query caches in place.
// PocketBase applies collection API rules to each stream, including league-member
// visibility for official-auction state.
//
// Patches are idempotent upserts keyed by record id, so an event echoing the
// local user's own optimistic write just re-applies identical data.
export function RealtimeSync() {
  const queryClient = useQueryClient();
  const { selectedAuction, selectedAuctionId, selectedYear } = useAuction();
  const { settings } = useLeague();
  const scoringFormat = settings.scoringFormat;

  // --- realtime connection recovery (3b) ---
  // The SDK auto-reconnects and re-submits subscriptions on a dropped SSE
  // stream, but exposes no "reconnected" callback — only `onDisconnect` and the
  // `isConnected` getter. A live-stream drop starts a temporary poller; recovery
  // stops it and resyncs caches that may have missed events while offline.
  useEffect(() => {
    let intervalId: ReturnType<typeof setInterval> | undefined;

    const recover = () => {
      if (intervalId !== undefined) {
        clearInterval(intervalId);
        intervalId = undefined;
      }
      void queryClient.invalidateQueries({ queryKey: ['draft-picks'] });
      void queryClient.invalidateQueries({ queryKey: ['auction-nomination'] });
      void queryClient.invalidateQueries({ queryKey: ['watchlist'] });
    };

    const previousOnDisconnect = pb.realtime.onDisconnect;
    pb.realtime.onDisconnect = (activeSubscriptions) => {
      previousOnDisconnect?.(activeSubscriptions);
      // Ignore teardown when nothing was subscribed — only a real mid-session
      // drop of active streams counts as "reconnecting".
      if (activeSubscriptions.length === 0) return;
      if (intervalId === undefined) {
        intervalId = setInterval(() => {
          if (pb.realtime.isConnected) recover();
        }, 2000);
      }
    };

    return () => {
      if (intervalId !== undefined) clearInterval(intervalId);
      pb.realtime.onDisconnect = previousOnDisconnect;
    };
  }, [queryClient]);

  // --- draft_picks (per selected auction) ---
  useEffect(() => {
    if (!selectedAuctionId) return;
    const auctionId = selectedAuctionId;
    let unsub: (() => void) | undefined;

    const seasonForPlayer = (playerId: string) => {
      const rows = queryClient.getQueryData<RecordModel[]>(seasonRowsQueryKey(selectedYear));
      return rows ? seasonMapFromRows(rows).get(playerId) : undefined;
    };

    const handle = (e: RealtimeEvent) => {
      const id = e.record.id;

      if (e.action === 'delete') {
        queryClient.setQueryData<DraftPickWithDetails[]>(['draft-picks', auctionId, scoringFormat], (old) =>
          old ? old.filter((p) => p.id !== id) : old
        );
        queryClient.setQueriesData<DraftPickWithDetails[]>(
          { queryKey: ['draft-picks', auctionId, scoringFormat, 'team'] },
          (old) => (old ? old.filter((p) => p.id !== id) : old)
        );
        queryClient.removeQueries({ queryKey: ['draft-pick', id] });
        return;
      }

      const mapped = mapPickRecord(
        e.record,
        scoringFormat,
        seasonForPlayer(e.record.player_id)
      );

      const upsert = (old: DraftPickWithDetails[] | undefined): DraftPickWithDetails[] => {
        if (!old) return [mapped];
        const idx = old.findIndex((p) => p.id === mapped.id);
        if (idx >= 0) {
          const copy = [...old];
          copy[idx] = mapped;
          return copy;
        }
        return [...old, mapped].sort((a, b) => a.pick_order - b.pick_order);
      };

      queryClient.setQueryData<DraftPickWithDetails[]>(['draft-picks', auctionId, scoringFormat], upsert);
      queryClient.setQueryData<DraftPickWithDetails[]>(
        ['draft-picks', auctionId, scoringFormat, 'team', mapped.fantasy_team_id],
        upsert
      );
      queryClient.setQueryData(['draft-pick', mapped.id, scoringFormat], mapped);
    };

    pb.collection('draft_picks')
      .subscribe('*', handle, {
        filter: pb.filter('auction_id = {:auctionId}', { auctionId }),
        expand: 'player_id,fantasy_team_id',
      })
      .then((fn) => {
        unsub = fn;
      })
      .catch((err) => console.error('draft_picks subscribe failed:', err));

    return () => {
      unsub?.();
    };
  }, [selectedAuctionId, selectedYear, scoringFormat, queryClient]);

  // --- auctions (lifecycle of the selected draft) ---
  // A commissioner completing the official draft is invisible to every other
  // member without this: no pick or nomination event accompanies it, so the
  // room would stay "live" until the next refetch. Invalidating is enough —
  // the auctions query is one small list.
  useEffect(() => {
    if (!selectedAuctionId) return;
    let unsub: (() => void) | undefined;

    pb.collection('auctions')
      .subscribe(selectedAuctionId, () => {
        void queryClient.invalidateQueries({ queryKey: ['auctions'] });
      })
      .then((fn) => {
        unsub = fn;
      })
      .catch((err) => console.error('auctions subscribe failed:', err));

    return () => {
      unsub?.();
    };
  }, [selectedAuctionId, queryClient]);

  // --- auction_nomination_events (shared official-auction state) ---
  useEffect(() => {
    if (!selectedAuctionId || selectedAuction?.type !== 'official') return;
    const auctionId = selectedAuctionId;
    let unsub: (() => void) | undefined;

    const handle = (e: RealtimeEvent) => {
      if (e.action !== 'create') return;
      const event = mapAuctionNominationEvent(e.record);
      queryClient.setQueryData<AuctionNominationEvent | null>(
        auctionNominationQueryKey(auctionId),
        (current) => newerNominationEvent(current, event),
      );
      // Keep the activity-log history (3e) live too — prepend unless already
      // present (the event can echo the local writer's own create).
      queryClient.setQueryData<AuctionNominationEvent[]>(
        auctionNominationHistoryQueryKey(auctionId),
        (current) => {
          if (!current) return current;
          if (current.some((existing) => existing.id === event.id)) return current;
          return [event, ...current].sort((a, b) => b.event_order - a.event_order);
        },
      );
    };

    pb.collection('auction_nomination_events')
      .subscribe('*', handle, {
        filter: pb.filter('auction_id = {:auctionId}', { auctionId }),
      })
      .then((fn) => {
        unsub = fn;
        // Close the small subscribe/fetch gap by re-reading the latest event
        // after the stream is established.
        void queryClient.invalidateQueries({
          queryKey: auctionNominationQueryKey(auctionId),
        });
      })
      .catch((err) => console.error('auction nominations subscribe failed:', err));

    return () => {
      unsub?.();
    };
  }, [selectedAuction?.type, selectedAuctionId, queryClient]);

  // --- watchlist (per user; scoped by API rule) ---
  useEffect(() => {
    const year = selectedYear;
    let unsub: (() => void) | undefined;

    const seasonForPlayer = (playerId: string) => {
      const rows = queryClient.getQueryData<RecordModel[]>(seasonRowsQueryKey(year));
      return rows ? seasonMapFromRows(rows).get(playerId) : undefined;
    };

    const handle = (e: RealtimeEvent) => {
      const id = e.record.id;

      if (e.action === 'delete') {
        queryClient.setQueryData<WatchlistWithDetails[]>(['watchlist', year, scoringFormat], (old) =>
          old ? old.filter((w) => w.id !== id) : old
        );
        return;
      }

      const mapped = mapWatchlistRecord(
        e.record,
        scoringFormat,
        seasonForPlayer(e.record.player_id)
      );
      queryClient.setQueryData<WatchlistWithDetails[]>(['watchlist', year, scoringFormat], (old) => {
        if (!old) return [mapped];
        // A create event for our own optimistic add supersedes the placeholder
        // row (id `optimistic-<playerId>`, from useAddToWatchlist) — drop it so
        // the same player doesn't render twice while the HTTP response is in
        // flight.
        const withoutPlaceholder = old.filter(
          (w) => w.id !== `optimistic-${mapped.player_id}`
        );
        const idx = withoutPlaceholder.findIndex((w) => w.id === mapped.id);
        if (idx >= 0) {
          const copy = [...withoutPlaceholder];
          copy[idx] = mapped;
          return copy;
        }
        return [...withoutPlaceholder, mapped].sort((a, b) => a.watch_order - b.watch_order);
      });
    };

    pb.collection('watchlist')
      .subscribe('*', handle, { expand: 'player_id' })
      .then((fn) => {
        unsub = fn;
      })
      .catch((err) => console.error('watchlist subscribe failed:', err));

    return () => {
      unsub?.();
    };
  }, [selectedYear, scoringFormat, queryClient]);

  return null;
}
