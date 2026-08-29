import { snakeSlotIndex } from './snake-draft';

interface DraftOrderTeam {
  id: string;
  draft_order: number;
}

export interface ProjectedTeamPick {
  /** Global pick_order this turn will carry (1-based, continuous with the auction phase). */
  pickOrder: number;
  /** Round label, on the same numbering as getSnakeRound (auction rounds counted first). */
  round: number;
  /** Seat within the round (1-based), for a "8.03" style label. */
  pickInRound: number;
  /** Picks that happen before this turn, counted from the pick currently on the clock. 0 = on the clock. */
  picksAway: number;
}

// Every remaining snake turn belonging to one team, in draft order. This is the
// data behind the "your next pick" lines in the players table: `picksAway` is
// how many players are expected off the board before that turn, so the line
// sits after that many available players.
//
// The snake phase restarts the rotation at the first team in draft order
// (see calculateCurrentSnakeTeam) — slots here are 0-based within the snake
// phase, not continuous with the auction nomination cursor.
export function getUpcomingTeamPicks({
  teams,
  totalPicks,
  teamId,
  totalRounds,
  paidAuctionSlots = 7,
}: {
  teams: DraftOrderTeam[];
  /** Picks already made in the whole auction, auction phase included. */
  totalPicks: number;
  teamId: string | null;
  /** Roster size — starters + bench — i.e. how many rounds the draft runs in total. */
  totalRounds: number;
  paidAuctionSlots?: number;
}): ProjectedTeamPick[] {
  const teamCount = teams.length;
  if (!teamId || teamCount === 0 || paidAuctionSlots <= 0) return [];

  const snakeRounds = totalRounds - paidAuctionSlots;
  if (snakeRounds <= 0) return [];

  const auctionPicks = paidAuctionSlots * teamCount;
  // Still in the auction phase — nothing to project yet.
  if (totalPicks < auctionPicks) return [];

  const ordered = [...teams].sort((a, b) => a.draft_order - b.draft_order);
  const currentSlot = totalPicks - auctionPicks;
  const lastSlot = snakeRounds * teamCount - 1;

  const picks: ProjectedTeamPick[] = [];
  for (let slot = currentSlot; slot <= lastSlot; slot++) {
    if (ordered[snakeSlotIndex(slot, teamCount)].id !== teamId) continue;
    picks.push({
      pickOrder: auctionPicks + slot + 1,
      round: Math.floor(slot / teamCount) + paidAuctionSlots + 1,
      pickInRound: (slot % teamCount) + 1,
      picksAway: slot - currentSlot,
    });
  }

  return picks;
}

// Where each projected turn's divider goes in a rendered player list: the row
// index of the Nth still-available player, for N = that turn's `picksAway`.
// Drafted rows are already off the board, so they neither advance the count
// nor can carry a divider — anchoring to one would strand the on-the-clock
// line above a block of players who are already gone.
export function mapPicksToRowIndices<T>(
  rows: readonly T[],
  isDrafted: (row: T) => boolean,
  upcoming: readonly ProjectedTeamPick[],
): Map<number, ProjectedTeamPick> {
  const lines = new Map<number, ProjectedTeamPick>();
  if (upcoming.length === 0) return lines;

  const byPicksAway = new Map(upcoming.map(pick => [pick.picksAway, pick]));
  let available = 0;
  for (let index = 0; index < rows.length && byPicksAway.size > 0; index++) {
    if (isDrafted(rows[index])) continue;
    const pick = byPicksAway.get(available);
    if (pick) {
      lines.set(index, pick);
      byPicksAway.delete(available);
    }
    available++;
  }
  return lines;
}
