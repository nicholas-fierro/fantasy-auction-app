import { deriveAdp } from '@/lib/adp';
import { snakeSlotIndex } from '@/lib/snake-draft';

export interface SurvivalInput {
  id: string;
  rank: number | null | undefined;
  ecr_vs_adp: number | null | undefined;
}

// Picks separating the user from their next turn, counting the overall pick
// about to be made (totalPicks) as pick 0. Both ends of the rotation covered:
// seat 12 in round 1 waits 1 pick (the wrap to round 2 seat 12 is their own),
// seat 1 in round 2 waits 23 picks. Returns null without a user seat.
export function picksUntilNextTurn(
  totalPicks: number,
  userDraftOrder: number | null | undefined,
  teamCount: number,
): number | null {
  if (teamCount <= 0 || totalPicks < 0) return null;
  if (userDraftOrder == null || userDraftOrder < 1 || userDraftOrder > teamCount) return null;
  const userSeat = userDraftOrder - 1;
  for (let offset = 0; offset < teamCount * 2; offset += 1) {
    if (snakeSlotIndex(totalPicks + offset, teamCount) === userSeat) return offset;
  }
  return null;
}

// A player is expected gone when their ADP falls strictly before the user's
// next turn. No ADP (null rank or absent delta) yields no prediction, never an
// optimistic guess. Callers hide the signal entirely when the board carries no
// ADP data (adpAvailable false).
//
// Two guards keep the flag honest. An ADP already behind the current pick is a
// faller the room passed on, not a player about to be taken — returning false
// rather than flagging a visible player "Gone". And with no picks between now
// and the user's turn there is no window for the player to go missing in, so
// the answer is null (callers suppress the column on the user's own turn).
export function isExpectedGoneBeforeNextTurn(
  player: SurvivalInput,
  picksAway: number | null,
  currentOverallPick: number,
): boolean | null {
  if (picksAway == null || picksAway <= 0) return null;
  const adp = deriveAdp(player.rank, player.ecr_vs_adp);
  if (adp == null) return null;
  if (adp < currentOverallPick) return false;
  return adp < currentOverallPick + picksAway;
}
