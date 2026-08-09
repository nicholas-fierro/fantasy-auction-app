import { describe, expect, it } from 'vitest';
import {
  canClearOfficialNomination,
  canNominateOfficialPlayer,
  getNominatorForPick,
} from './draft-turn';

const teams = [
  { id: 'team-a', draft_order: 1 },
  { id: 'team-b', draft_order: 2 },
  { id: 'team-c', draft_order: 3 },
];

describe('official draft turn permissions', () => {
  it('snakes the nomination order so the turn reverses at each round boundary', () => {
    const order = Array.from(
      { length: 6 },
      (_, pickCount) => getNominatorForPick(pickCount, [], teams, 7),
    );

    expect(order).toEqual([
      'team-a', 'team-b', 'team-c',
      'team-c', 'team-b', 'team-a',
    ]);
  });

  it('skips teams whose paid slots are full', () => {
    const picks = [
      { fantasy_team_id: 'team-a', price: 10 },
      { fantasy_team_id: 'team-b', price: 8 },
      { fantasy_team_id: 'team-a', price: 5 },
    ];

    expect(getNominatorForPick(0, [], teams, 2)).toBe('team-a');
    expect(getNominatorForPick(1, picks, teams, 2)).toBe('team-b');
    // team-a is full after three picks, so the reversed round hands off to team-c.
    expect(getNominatorForPick(3, picks, teams, 2)).toBe('team-c');
  });

  it('lets a member nominate only on their turn without replacing another author', () => {
    const base = {
      isCommissioner: false,
      userId: 'user-a',
      userTeamId: 'team-a',
      currentNominatorTeamId: 'team-a',
      activeNominationUserId: null,
    };

    expect(canNominateOfficialPlayer(base)).toBe(true);
    expect(canNominateOfficialPlayer({
      ...base,
      currentNominatorTeamId: 'team-b',
    })).toBe(false);
    expect(canNominateOfficialPlayer({
      ...base,
      activeNominationUserId: 'user-b',
    })).toBe(false);
    expect(canNominateOfficialPlayer({
      ...base,
      activeNominationUserId: 'user-a',
    })).toBe(true);
  });

  it('only lets the author or commissioner clear a live nomination', () => {
    expect(canClearOfficialNomination({
      isCommissioner: false,
      userId: 'user-a',
      activeNominationUserId: 'user-a',
    })).toBe(true);
    expect(canClearOfficialNomination({
      isCommissioner: false,
      userId: 'user-b',
      activeNominationUserId: 'user-a',
    })).toBe(false);
    expect(canClearOfficialNomination({
      isCommissioner: true,
      userId: 'commissioner',
      activeNominationUserId: 'user-a',
    })).toBe(true);
  });
});
