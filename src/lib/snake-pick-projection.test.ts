import { describe, expect, it } from 'vitest';
import { getUpcomingTeamPicks, mapPicksToRowIndices } from './snake-pick-projection';

const teams = [
  { id: 'team-a', draft_order: 1 },
  { id: 'team-b', draft_order: 2 },
  { id: 'team-c', draft_order: 3 },
];

// 3 teams, 2 paid auction slots, 5 total rounds => 3 snake rounds, slots 0..8:
// round 1: a b c, round 2: c b a, round 3: a b c
const base = { teams, totalRounds: 5, paidAuctionSlots: 2 };
const AUCTION_PICKS = 6; // 2 slots * 3 teams

describe('getUpcomingTeamPicks', () => {
  it('projects every remaining turn for a team at the start of the snake phase', () => {
    expect(getUpcomingTeamPicks({ ...base, totalPicks: AUCTION_PICKS, teamId: 'team-a' })).toEqual([
      { pickOrder: 7, round: 3, pickInRound: 1, picksAway: 0 },
      { pickOrder: 12, round: 4, pickInRound: 3, picksAway: 5 },
      { pickOrder: 13, round: 5, pickInRound: 1, picksAway: 6 },
    ]);
  });

  it('counts picksAway from the pick currently on the clock', () => {
    // Two snake picks made: team-c is on the clock (slot 2).
    expect(getUpcomingTeamPicks({ ...base, totalPicks: AUCTION_PICKS + 2, teamId: 'team-c' })).toEqual([
      { pickOrder: 9, round: 3, pickInRound: 3, picksAway: 0 },
      { pickOrder: 10, round: 4, pickInRound: 1, picksAway: 1 },
      { pickOrder: 15, round: 5, pickInRound: 3, picksAway: 6 },
    ]);
  });

  it('turns back-to-back turns at a round boundary into consecutive lines', () => {
    const picks = getUpcomingTeamPicks({ ...base, totalPicks: AUCTION_PICKS, teamId: 'team-c' });
    expect(picks.map(pick => pick.picksAway)).toEqual([2, 3, 8]);
  });

  it('returns nothing while the auction phase is still running', () => {
    expect(getUpcomingTeamPicks({ ...base, totalPicks: AUCTION_PICKS - 1, teamId: 'team-a' })).toEqual([]);
  });

  it('returns nothing once the snake phase is exhausted', () => {
    expect(getUpcomingTeamPicks({ ...base, totalPicks: AUCTION_PICKS + 9, teamId: 'team-a' })).toEqual([]);
  });

  it('returns nothing without a team, without teams, or with no snake rounds', () => {
    expect(getUpcomingTeamPicks({ ...base, totalPicks: AUCTION_PICKS, teamId: null })).toEqual([]);
    expect(getUpcomingTeamPicks({ ...base, teams: [], totalPicks: AUCTION_PICKS, teamId: 'team-a' })).toEqual([]);
    expect(getUpcomingTeamPicks({ ...base, totalRounds: 2, totalPicks: AUCTION_PICKS, teamId: 'team-a' })).toEqual([]);
  });

  it('agrees with the live snake rotation about who is on the clock', () => {
    for (let made = 0; made < 9; made++) {
      const onClock = teams.find(team =>
        getUpcomingTeamPicks({ ...base, totalPicks: AUCTION_PICKS + made, teamId: team.id })[0]?.picksAway === 0,
      );
      const expected = ['team-a', 'team-b', 'team-c', 'team-c', 'team-b', 'team-a', 'team-a', 'team-b', 'team-c'][made];
      expect(onClock?.id).toBe(expected);
    }
  });
});

describe('mapPicksToRowIndices', () => {
  const pick = (picksAway: number) => ({
    pickOrder: 100 + picksAway,
    round: 8,
    pickInRound: 1,
    picksAway,
  });
  // Rows are `[name, drafted]`; the mapper only cares about the flag.
  const row = (drafted: boolean) => ({ drafted });
  const isDrafted = (r: { drafted: boolean }) => r.drafted;

  it('anchors each divider to the Nth still-available row', () => {
    const rows = [false, false, false, false].map(row);
    const lines = mapPicksToRowIndices(rows, isDrafted, [pick(0), pick(2)]);
    expect([...lines.keys()]).toEqual([0, 2]);
  });

  it('skips drafted rows so the on-the-clock line lands on the best available player', () => {
    // The top three of the board were auctioned off and are still rendered
    // ("hide drafted" off) — the divider belongs at row 3, not row 0.
    const rows = [true, true, true, false, false].map(row);
    const lines = mapPicksToRowIndices(rows, isDrafted, [pick(0), pick(1)]);
    expect([...lines.keys()]).toEqual([3, 4]);
  });

  it('does not let drafted rows advance the pick count', () => {
    // Two available rows, then a drafted one, then more available: the
    // 2-picks-away line sits on the third *available* row — index 3, since
    // the drafted row between them is not a pick anyone spends.
    const rows = [false, false, true, false, false].map(row);
    const lines = mapPicksToRowIndices(rows, isDrafted, [pick(2)]);
    expect([...lines.keys()]).toEqual([3]);
  });

  it('drops turns projected past the end of the visible board', () => {
    const rows = [false, false].map(row);
    const lines = mapPicksToRowIndices(rows, isDrafted, [pick(0), pick(9)]);
    expect([...lines.keys()]).toEqual([0]);
  });

  it('returns nothing with no upcoming turns or no rows', () => {
    expect(mapPicksToRowIndices([false].map(row), isDrafted, []).size).toBe(0);
    expect(mapPicksToRowIndices([], isDrafted, [pick(0)]).size).toBe(0);
  });

  it('carries the projected turn through as the map value', () => {
    const target = pick(3);
    const rows = [false, false, false, false].map(row);
    expect(mapPicksToRowIndices(rows, isDrafted, [target]).get(3)).toBe(target);
  });
});
