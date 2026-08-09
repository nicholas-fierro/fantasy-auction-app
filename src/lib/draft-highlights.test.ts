import { describe, expect, it } from 'vitest';
import type { DraftPickWithDetails } from '@/server/types/draft-pick';
import { formatDraftDuration, getDraftHighlights } from './draft-highlights';

function pick(overrides: Partial<DraftPickWithDetails> & {
  id: string;
  pick_order: number;
}): DraftPickWithDetails {
  const teamId = overrides.fantasy_team_id ?? 'team-1';
  return {
    auction_id: 'auction',
    fantasy_team_id: teamId,
    player_id: overrides.id,
    price: null,
    timestamp: '2026-07-28T12:00:00.000Z',
    created: '',
    updated: '',
    player: {
      id: overrides.id,
      season_id: 'season',
      name: overrides.id,
      team: 'NFL',
      position: 'RB',
      position_rank: 1,
      bye_week: 7,
      sos: 0,
      ecr_vs_adp: 0,
      rank: 1,
      tier: 1,
      projected_auction_value: null,
      is_rookie: false,
      sleeper_id: null,
      espn_id: null,
      gsis_id: null,
      fantasypros_id: null,
      created: '',
      updated: '',
    },
    team: { id: teamId, name: 'Team One', draft_order: 1, created: '', updated: '' },
    ...overrides,
  };
}

describe('draft highlights', () => {
  it('selects value highlights and measures first-to-last pick duration', () => {
    const picks = [
      pick({
        id: 'middle', pick_order: 2, price: 45,
        timestamp: '2026-07-28T12:30:00.000Z',
        player: { ...pick({ id: 'middle-player', pick_order: 2 }).player, projected_auction_value: 30 },
      }),
      pick({
        id: 'first', pick_order: 1, price: 20,
        timestamp: '2026-07-28T12:00:00.000Z',
        player: { ...pick({ id: 'first-player', pick_order: 1 }).player, projected_auction_value: 35 },
      }),
      pick({
        id: 'last', pick_order: 3, price: 50,
        timestamp: '2026-07-28T14:05:00.000Z',
        player: { ...pick({ id: 'last-player', pick_order: 3 }).player, projected_auction_value: 48 },
      }),
    ];

    const result = getDraftHighlights(picks);

    expect(result.priciest?.id).toBe('last');
    expect(result.biggestBargain).toMatchObject({ pick: { id: 'first' }, difference: 15 });
    expect(result.biggestOverpay).toMatchObject({ pick: { id: 'middle' }, difference: 15 });
    expect(result.durationMs).toBe(2 * 60 * 60 * 1000 + 5 * 60 * 1000);
    expect(formatDraftDuration(result.durationMs)).toBe('2 hr 5 min');
  });

  it('returns no overpay when every pick is below projection', () => {
    const result = getDraftHighlights([
      pick({
        id: 'smaller-bargain', pick_order: 1, price: 20,
        player: { ...pick({ id: 'smaller-bargain-player', pick_order: 1 }).player, projected_auction_value: 30 },
      }),
      pick({
        id: 'biggest-bargain', pick_order: 2, price: 10,
        player: { ...pick({ id: 'biggest-bargain-player', pick_order: 2 }).player, projected_auction_value: 40 },
      }),
    ]);

    expect(result.biggestBargain).toMatchObject({ pick: { id: 'biggest-bargain' }, difference: 30 });
    expect(result.biggestOverpay).toBeNull();
  });

  it('returns no bargain when every pick is above projection', () => {
    const result = getDraftHighlights([
      pick({
        id: 'smaller-overpay', pick_order: 1, price: 40,
        player: { ...pick({ id: 'smaller-overpay-player', pick_order: 1 }).player, projected_auction_value: 30 },
      }),
      pick({
        id: 'biggest-overpay', pick_order: 2, price: 55,
        player: { ...pick({ id: 'biggest-overpay-player', pick_order: 2 }).player, projected_auction_value: 40 },
      }),
    ]);

    expect(result.biggestBargain).toBeNull();
    expect(result.biggestOverpay).toMatchObject({ pick: { id: 'biggest-overpay' }, difference: 15 });
  });

  it('returns no value highlight for an exact projection match', () => {
    const result = getDraftHighlights([
      pick({
        id: 'exact', pick_order: 1, price: 25,
        player: { ...pick({ id: 'exact-player', pick_order: 1 }).player, projected_auction_value: 25 },
      }),
    ]);

    expect(result.biggestBargain).toBeNull();
    expect(result.biggestOverpay).toBeNull();
  });

  it('returns safe empty-state values for missing prices and invalid timestamps', () => {
    const result = getDraftHighlights([
      pick({ id: 'one', pick_order: 1, timestamp: 'not-a-date' }),
    ]);

    expect(result).toMatchObject({
      priciest: null,
      biggestBargain: null,
      biggestOverpay: null,
      durationMs: null,
      viewerLine: null,
    });
    expect(formatDraftDuration(null)).toBe('Not available');
  });

  it('highlights the viewer’s best value pick while ignoring unpriced picks', () => {
    const result = getDraftHighlights([
      pick({
        id: 'nico', pick_order: 1, fantasy_team_id: 'mine', price: 12,
        player: { ...pick({ id: 'nico-player', pick_order: 1 }).player, name: 'Nico Collins', projected_auction_value: 24 },
      }),
      pick({ id: 'unpriced', pick_order: 2, fantasy_team_id: 'mine' }),
      pick({
        id: 'smaller-value', pick_order: 3, fantasy_team_id: 'mine', price: 18,
        player: { ...pick({ id: 'smaller-value-player', pick_order: 3 }).player, projected_auction_value: 25 },
      }),
      pick({
        id: 'other-team', pick_order: 4, fantasy_team_id: 'other', price: 1,
        player: { ...pick({ id: 'other-team-player', pick_order: 4 }).player, projected_auction_value: 50 },
      }),
    ], 'mine');

    expect(result.viewerLine).toBe('Your best value: Nico Collins, $12 under projection.');
  });

  it('uses viewer-specific fallbacks when no positive value pick exists', () => {
    expect(getDraftHighlights([], 'mine').viewerLine).toBe('Your team made no picks.');
    expect(getDraftHighlights([
      pick({ id: 'unpriced', pick_order: 1, fantasy_team_id: 'mine' }),
      pick({
        id: 'overpay', pick_order: 2, fantasy_team_id: 'mine', price: 20,
        player: { ...pick({ id: 'overpay-player', pick_order: 2 }).player, projected_auction_value: 15 },
      }),
      pick({
        id: 'other-value', pick_order: 3, fantasy_team_id: 'other', price: 5,
        player: { ...pick({ id: 'other-value-player', pick_order: 3 }).player, projected_auction_value: 30 },
      }),
    ], 'mine').viewerLine).toBe('Your team had no picks under projection.');
    expect(formatDraftDuration(30_000)).toBe('Under a minute');
  });
});
