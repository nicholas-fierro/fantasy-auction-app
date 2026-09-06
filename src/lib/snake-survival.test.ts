import { describe, expect, it } from 'vitest';
import { isExpectedGoneBeforeNextTurn, picksUntilNextTurn } from './snake-survival';

describe('picksUntilNextTurn', () => {
  it('returns zero on the user turn', () => {
    expect(picksUntilNextTurn(0, 1, 12)).toBe(0);
    expect(picksUntilNextTurn(12, 12, 12)).toBe(0);
  });

  it('covers both ends of the rotation', () => {
    // Seat 12 picks last in round 1 and first in round 2: on the clock at
    // both the 12th overall pick (11 made) and the 13th (12 made).
    expect(picksUntilNextTurn(11, 12, 12)).toBe(0);
    expect(picksUntilNextTurn(12, 12, 12)).toBe(0);
    // Seat 1 at the start of round 2 (12 made) waits out the whole round: 11 away.
    expect(picksUntilNextTurn(12, 1, 12)).toBe(11);
    // Seat 1 just after picking first overall (1 made) has the longest wait: 22 away.
    expect(picksUntilNextTurn(1, 1, 12)).toBe(22);
  });

  it('returns null without a user seat or valid board', () => {
    expect(picksUntilNextTurn(0, null, 12)).toBeNull();
    expect(picksUntilNextTurn(0, 13, 12)).toBeNull();
    expect(picksUntilNextTurn(0, 1, 0)).toBeNull();
    expect(picksUntilNextTurn(-1, 1, 12)).toBeNull();
  });
});

describe('isExpectedGoneBeforeNextTurn', () => {
  it('flags players taken before the next turn', () => {
    // Overall pick 13 upcoming, user 5 away (next turn is 18): ADP 18 survives, ADP 17 does not.
    expect(isExpectedGoneBeforeNextTurn({ id: 'a', rank: 10, ecr_vs_adp: 8 }, 5, 13)).toBe(false);
    expect(isExpectedGoneBeforeNextTurn({ id: 'b', rank: 10, ecr_vs_adp: 7 }, 5, 13)).toBe(true);
  });

  it('returns null with no ADP rather than guessing', () => {
    expect(isExpectedGoneBeforeNextTurn({ id: 'a', rank: null, ecr_vs_adp: 5 }, 5, 13)).toBeNull();
    expect(isExpectedGoneBeforeNextTurn({ id: 'b', rank: 10, ecr_vs_adp: null }, 5, 13)).toBeNull();
    expect(isExpectedGoneBeforeNextTurn({ id: 'c', rank: 10, ecr_vs_adp: 5 }, null, 13)).toBeNull();
  });

  it('never flags a faller sitting on the board as gone', () => {
    // ADP 5 still undrafted at overall pick 40: the room passed, not a player
    // about to be taken.
    expect(isExpectedGoneBeforeNextTurn({ id: 'a', rank: 3, ecr_vs_adp: 2 }, 11, 40)).toBe(false);
  });

  it('returns null on the user turn instead of flagging the whole board', () => {
    expect(isExpectedGoneBeforeNextTurn({ id: 'a', rank: 10, ecr_vs_adp: 7 }, 0, 13)).toBeNull();
  });
});
