import { snakeSlotIndex } from './snake-draft';

interface PricedTeamPick {
  fantasy_team_id: string;
  price: number | null;
}

interface DraftOrderTeam {
  id: string;
  draft_order: number;
}

// Which team nominates the auction pick at index `pickCount` (0-indexed count
// of auction picks already made). Nomination turns snake on the same rule as
// the rest of the draft (snakeSlotIndex). Replay the rotation from the
// beginning so a refresh needs no transient turn state. Teams that have filled
// their paid slots are skipped. Keep the drift-guard block in
// pb_hooks/auction_nomination_permissions.pb.js aligned with this function;
// src/lib/draft-turn.golden.test.ts executes both implementations.
export function getNominatorForPick(
  pickCount: number,
  picks: PricedTeamPick[],
  teams: DraftOrderTeam[],
  paidAuctionSlots = 7,
): string | null {
  const ordered = [...teams].sort((a, b) => a.draft_order - b.draft_order);
  const teamCount = ordered.length;
  if (teamCount === 0 || paidAuctionSlots <= 0) return null;

  const pricedPickCounts = new Map<string, number>();
  for (const team of ordered) pricedPickCounts.set(team.id, 0);

  let cursor = 0;
  for (let index = 0; index <= pickCount; index++) {
    // The snake sequence has period 2 * teamCount (each team gets two slots per
    // period), so only a window that wide is guaranteed to reach every team
    // from an arbitrary cursor. A shorter window can declare "everyone is full"
    // while a team with open slots sits just past its end, which would strand
    // the auction with no legal nominator.
    const maxAttempts = 2 * teamCount;
    let attempts = 0;
    while (
      attempts < maxAttempts &&
      (pricedPickCounts.get(ordered[snakeSlotIndex(cursor, teamCount)].id) ?? 0) >=
        paidAuctionSlots
    ) {
      cursor++;
      attempts++;
    }
    if (attempts >= maxAttempts) return null;

    const nominatorId = ordered[snakeSlotIndex(cursor, teamCount)].id;
    if (index === pickCount) return nominatorId;

    cursor++;
    const pick = picks[index];
    if (pick && pick.price != null && pick.price > 0) {
      pricedPickCounts.set(
        pick.fantasy_team_id,
        (pricedPickCounts.get(pick.fantasy_team_id) ?? 0) + 1,
      );
    }
  }

  return null;
}

export function canNominateOfficialPlayer({
  isCommissioner,
  userTeamId,
  currentNominatorTeamId,
  activeNominationUserId,
  userId,
}: {
  isCommissioner: boolean;
  userTeamId: string | null;
  currentNominatorTeamId: string | null;
  activeNominationUserId: string | null;
  userId: string | null;
}): boolean {
  if (isCommissioner) return true;
  return (
    !!userId &&
    !!userTeamId &&
    userTeamId === currentNominatorTeamId &&
    (!activeNominationUserId || activeNominationUserId === userId)
  );
}

export function canClearOfficialNomination({
  isCommissioner,
  userId,
  activeNominationUserId,
}: {
  isCommissioner: boolean;
  userId: string | null;
  activeNominationUserId: string | null;
}): boolean {
  return (
    isCommissioner ||
    (!!userId && !!activeNominationUserId && activeNominationUserId === userId)
  );
}
