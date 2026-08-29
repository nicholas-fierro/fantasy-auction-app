import { describe, expect, it } from 'vitest';
import { getUpcomingTeamPicks } from './snake-pick-projection';

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
