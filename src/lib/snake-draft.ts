import { FantasyTeam } from '@/server/types/fantasy-team';
import { DraftPickWithDetails } from '@/server/types/draft-pick';

const DEFAULT_PAID_AUCTION_SLOTS = 7;
const DEFAULT_TEAM_COUNT = 12;

export interface SnakeTeamQueue {
  currentTeam: FantasyTeam | null;
  nextTeam: FantasyTeam | null;
}

export function isAuctionPick(
  pickOrder: number,
  teamCount = DEFAULT_TEAM_COUNT,
  paidAuctionSlots = DEFAULT_PAID_AUCTION_SLOTS,
): boolean {
  return pickOrder <= paidAuctionSlots * teamCount;
}

export function isSnakePick(
  pickOrder: number,
  teamCount = DEFAULT_TEAM_COUNT,
  paidAuctionSlots = DEFAULT_PAID_AUCTION_SLOTS,
): boolean {
  return !isAuctionPick(pickOrder, teamCount, paidAuctionSlots);
}

export function getSnakeRound(
  pickOrder: number,
  teamCount = DEFAULT_TEAM_COUNT,
  paidAuctionSlots = DEFAULT_PAID_AUCTION_SLOTS,
): number {
  if (teamCount <= 0 || paidAuctionSlots <= 0) {
    throw new Error('Team count and paid auction slots must define a valid draft');
  }
  if (isAuctionPick(pickOrder, teamCount, paidAuctionSlots)) {
    throw new Error('Pick order is in auction phase, not snake phase');
  }
  const snakePickNumber = pickOrder - paidAuctionSlots * teamCount;
  return Math.ceil(snakePickNumber / teamCount) + paidAuctionSlots;
}

// The snake rule, applied separately to each phase: slot 0 is round 1 seat 1,
// rounds alternate direction, so the last team of a round also takes the first
// turn of the next one. `slot` is a 0-based count of turns taken WITHIN the
// phase — the nomination cursor in the auction phase (where a skipped full team
// still burns a slot), and reset to 0 at the first snake pick, because the
// snake restarts at the first team in draft order.
// Keep the drift-guard blocks in pb_hooks/auction_nomination_permissions.pb.js
// and pb_hooks/draft_picks_pick_order.pb.js aligned with this function;
// src/lib/draft-turn.golden.test.ts executes all three.
export function snakeSlotIndex(slot: number, teamCount: number): number {
  const round = Math.floor(slot / teamCount);
  const position = slot % teamCount;
  return round % 2 === 0 ? position : teamCount - 1 - position;
}

export function calculateCurrentSnakeTeam(
  teams: FantasyTeam[],
  totalPicks: number,
  paidAuctionSlots = DEFAULT_PAID_AUCTION_SLOTS,
): SnakeTeamQueue {
  const teamCount = teams.length;
  if (teamCount === 0 || paidAuctionSlots <= 0) {
    return { currentTeam: null, nextTeam: null };
  }
  if (totalPicks < paidAuctionSlots * teamCount) {
    return { currentTeam: null, nextTeam: null };
  }

  const sortedTeams = [...teams].sort((a, b) => a.draft_order - b.draft_order);
  // The snake phase restarts the rotation: the first snake pick goes to the
  // first team in draft order regardless of which direction the auction
  // nomination rotation ended on. So the slot counter is 0-based within the
  // snake phase, not continuous with the auction phase.
  const snakeSlot = totalPicks - paidAuctionSlots * teamCount;

  return {
    currentTeam: sortedTeams[snakeSlotIndex(snakeSlot, teamCount)] || null,
    nextTeam: sortedTeams[snakeSlotIndex(snakeSlot + 1, teamCount)] || null,
  };
}

export function getTeamPickCount(
  teamId: string,
  draftPicks: DraftPickWithDetails[]
): number {
  return draftPicks.filter(pick => pick.fantasy_team_id === teamId).length;
}

export function getTeamRoundForPick(
  teamId: string,
  draftPicks: DraftPickWithDetails[]
): number {
  return getTeamPickCount(teamId, draftPicks) + 1;
}