import { describe, expect, it } from 'vitest';
import { getActiveNominationPlayerId, newerNominationEvent } from '@/lib/active-nomination';
import { AuctionNominationEvent } from '@/server/types/auction-nomination';

function event(
  action: AuctionNominationEvent['action'],
  created: string,
  playerId: string | null = 'player-1',
  eventOrder = 1,
  pickCount = 0,
): AuctionNominationEvent {
  return {
    id: `event-${created}`,
    auction_id: 'auction-1',
    player_id: action === 'clear' ? null : playerId,
    user: 'user-1',
    action,
    event_order: eventOrder,
    pick_count: pickCount,
    created,
  };
}

describe('getActiveNominationPlayerId', () => {
  it('returns the latest nominated player when no sale follows it', () => {
    expect(getActiveNominationPlayerId(
      event('nominate', '2026-07-17 01:00:01.000Z', 'player-1', 1, 1),
      [{}],
    )).toBe('player-1');
  });

  it('clears a nomination after its draft pick is recorded', () => {
    expect(getActiveNominationPlayerId(
      event('nominate', '2026-07-17 01:00:01.000Z'),
      [{ created: '2026-07-17 01:00:02.000Z' }],
    )).toBeNull();
  });

  it('honors an explicit clear event', () => {
    expect(getActiveNominationPlayerId(
      event('clear', '2026-07-17 01:00:01.000Z'),
      [],
    )).toBeNull();
  });
});

describe('newerNominationEvent', () => {
  it('uses the server-assigned order for equal-timestamp events', () => {
    const current = { ...event('nominate', '2026-07-17 01:00:01.000Z', 'player-1', 1), id: 'event-z' };
    const incoming = { ...event('clear', '2026-07-17 01:00:01.000Z', null, 2), id: 'event-a' };

    expect(newerNominationEvent(current, incoming)).toBe(incoming);
    expect(newerNominationEvent(incoming, current)).toBe(incoming);
  });
});
