import { AuctionNominationEvent } from '@/server/types/auction-nomination';

// `event_order` is assigned per auction by PocketBase, so realtime clients
// converge even when multiple events share the same millisecond timestamp.
export function newerNominationEvent(
  current: AuctionNominationEvent | null | undefined,
  incoming: AuctionNominationEvent,
): AuctionNominationEvent {
  if (
    !current ||
    incoming.id === current.id ||
    incoming.event_order > current.event_order
  ) {
    return incoming;
  }
  return current;
}

// A sale resolves whichever nomination preceded it. The event's server-assigned
// pick-count snapshot avoids cross-collection timestamp comparisons. Keeping
// this derivation client-side means the existing realtime draft-pick event clears
// the nomination for every viewer without a second mutable server write.
export function getActiveNominationPlayerId(
  latestEvent: AuctionNominationEvent | null | undefined,
  picks: unknown[],
): string | null {
  if (!latestEvent || latestEvent.action === 'clear' || !latestEvent.player_id) {
    return null;
  }

  return picks.length > latestEvent.pick_count
    ? null
    : latestEvent.player_id;
}
