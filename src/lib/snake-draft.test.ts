import { describe, expect, it } from 'vitest';
import type { FantasyTeam } from '@/server/types/fantasy-team';
import type { DraftPickWithDetails } from '@/server/types/draft-pick';
import {
  calculateCurrentSnakeTeam,
  getSnakeRound,
  getTeamPickCount,
  getTeamRoundForPick,
  isAuctionPick,
  isSnakePick,
  snakeSlotIndex,
} from './snake-draft';

const teams: FantasyTeam[] = Array.from({ length: 12 }, (_, index) => ({
  id: `team-${index + 1}`, name: `Team ${index + 1}`, draft_order: index + 1,
  created: '', updated: '',
})).reverse();

const order = Array.from({ length: 14 }, (_, round) =>
  Array.from({ length: 12 }, (_, seat) => round % 2 === 0 ? seat + 1 : 12 - seat),
).flat();

describe('pure snake draft', () => {
  it('supports every pick from round one through round fourteen', () => {
    const picks: DraftPickWithDetails[] = [];
    order.forEach((teamNumber, index) => {
      const pickOrder = index + 1;
      const teamId = `team-${teamNumber}`;
      expect(isAuctionPick(pickOrder, 12, 0)).toBe(false);
      expect(isSnakePick(pickOrder, 12, 0)).toBe(true);
      expect(getSnakeRound(pickOrder, 12, 0)).toBe(Math.floor(index / 12) + 1);
      expect(snakeSlotIndex(index, 12)).toBe(teamNumber - 1);
      const queue = calculateCurrentSnakeTeam(teams, index, 0);
      expect(queue.currentTeam?.id).toBe(teamId);
      expect(queue.nextTeam?.id).toBe(`team-${order[index + 1] ?? 1}`);
      expect(getTeamRoundForPick(teamId, picks)).toBe(getSnakeRound(pickOrder, 12, 0));
      picks.push({ fantasy_team_id: teamId } as DraftPickWithDetails);
    });
    for (const team of teams) expect(getTeamPickCount(team.id, picks)).toBe(14);
  });

  it('preserves the hybrid sequence with only the auction offset added', () => {
    order.forEach((teamNumber, index) => {
      expect(calculateCurrentSnakeTeam(teams, 84 + index).currentTeam?.id).toBe(`team-${teamNumber}`);
      expect(getSnakeRound(85 + index)).toBe(Math.floor(index / 12) + 8);
      expect(isSnakePick(85 + index)).toBe(true);
    });
    expect(isAuctionPick(84)).toBe(true);
    expect(calculateCurrentSnakeTeam(teams, 83).currentTeam).toBeNull();
    expect(() => getSnakeRound(84)).toThrow('auction phase');
  });

  it('still rejects invalid offsets and missing teams', () => {
    expect(() => getSnakeRound(1, 12, -1)).toThrow('valid draft');
    expect(() => getSnakeRound(1, 0, 0)).toThrow('valid draft');
    expect(calculateCurrentSnakeTeam(teams, 0, -1)).toEqual({ currentTeam: null, nextTeam: null });
    expect(calculateCurrentSnakeTeam([], 0, 0)).toEqual({ currentTeam: null, nextTeam: null });
  });
});
