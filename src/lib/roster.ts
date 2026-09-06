import type { DraftPickWithDetails } from '@/server/types/draft-pick';
import type { Player } from '@/server/types/player';
import type { ScoringFormat } from '@/lib/fantasy-scoring';

export type DraftFormat = 'auction' | 'hybrid' | 'snake';

export function isDraftFormat(value: unknown): value is DraftFormat {
  return value === 'auction' || value === 'hybrid' || value === 'snake';
}

// Whether a team is the signed-in user's own team. The user's team id comes
// from their league_members row (useUserTeamId in src/hooks/use-league.ts) —
// it replaced the hardcoded USER_TEAM_ID constant when the app went
// multi-user (docs/multi-user-plan.md). Null (no membership resolved yet)
// matches no team.
export function isUserTeam(team: { id: string }, userTeamId: string | null): boolean {
  return userTeamId !== null && team.id === userTeamId;
}

export interface RosterSettings {
  budget: number;
  paidAuctionSlots: number;
  minimumBid: number;
  starterPositions: readonly string[];
  benchSize: number;
  // Points per reception the league plays. Seeds the game-log view's scoring
  // toggle; imported rankings are half-PPR, which is why that's the default.
  scoringFormat: ScoringFormat;
  draftFormat: DraftFormat;
}

export const DEFAULT_ROSTER_SETTINGS: RosterSettings = {
  budget: 200,
  paidAuctionSlots: 7,
  minimumBid: 1,
  starterPositions: ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'K', 'DST'],
  benchSize: 6,
  scoringFormat: 'half',
  draftFormat: 'hybrid',
};

// Shared form validation; draft format is explicit, never inferred from paid slots.
export function validateRosterSettings(settings: RosterSettings): string | null {
  if (!isDraftFormat(settings.draftFormat)) {
    return 'Choose a valid draft format';
  }

  const isSnake = settings.draftFormat === 'snake';
  if (!Number.isFinite(settings.budget) || (isSnake ? settings.budget < 0 : settings.budget <= 0)) {
    return isSnake ? 'Budget must be a non-negative number' : 'Budget must be a positive number';
  }
  if (!Number.isInteger(settings.paidAuctionSlots) || (isSnake ? settings.paidAuctionSlots !== 0 : settings.paidAuctionSlots <= 0)) {
    return isSnake ? 'Snake drafts must have zero paid slots' : 'Paid slots must be a positive integer';
  }
  if (!Number.isFinite(settings.minimumBid) || settings.minimumBid < (isSnake ? 0 : 1)) {
    return isSnake ? 'Minimum bid must be a non-negative number' : 'Minimum bid must be at least $1';
  }
  if (!Number.isInteger(settings.benchSize) || settings.benchSize < 0) {
    return 'Bench size must be a non-negative integer';
  }
  if (settings.starterPositions.length === 0) {
    return 'Add at least one starter position';
  }
  if (settings.paidAuctionSlots > settings.starterPositions.length + settings.benchSize) {
    return 'Paid slots cannot exceed starter positions plus bench size';
  }
  if (settings.budget < settings.paidAuctionSlots * settings.minimumBid) {
    return 'Budget must cover all paid slots at the minimum bid';
  }
  return null;
}

export interface RosterSlot {
  position: string;
  player: Player | null;
}

export interface RosterData {
  starters: RosterSlot[];
  bench: RosterSlot[];
}

export interface BudgetSummary {
  totalSpent: number;
  remainingBudget: number;
  remainingAuctionPicks: number;
  maxBid: number;
}

export function buildRosterFromPicks(
  draftPicks: readonly DraftPickWithDetails[],
  settings: RosterSettings = DEFAULT_ROSTER_SETTINGS
): RosterData {
  const sortedPicks = [...draftPicks].sort((a, b) => a.pick_order - b.pick_order);
  const starters: RosterSlot[] = settings.starterPositions.map(position => ({
    position,
    player: null,
  }));
  const bench: RosterSlot[] = [];

  for (const pick of sortedPicks) {
    const position = pick.player.position;
    let starterIndex = starters.findIndex(
      slot => slot.position === position && slot.player === null
    );

    if (starterIndex === -1 && ['RB', 'WR', 'TE'].includes(position)) {
      starterIndex = starters.findIndex(
        slot => slot.position === 'FLEX' && slot.player === null
      );
    }

    if (starterIndex !== -1) {
      starters[starterIndex] = {
        ...starters[starterIndex],
        player: pick.player,
      };
    } else {
      bench.push({ position: 'BN', player: pick.player });
    }
  }

  while (bench.length < settings.benchSize) {
    bench.push({ position: 'BN', player: null });
  }

  return { starters, bench };
}

export function calculateBudgetSummary(
  draftPicks: readonly DraftPickWithDetails[],
  settings: RosterSettings = DEFAULT_ROSTER_SETTINGS
): BudgetSummary {
  const totalSpent = draftPicks.reduce((sum, pick) => sum + (pick.price ?? 0), 0);
  const auctionPicksMade = draftPicks.filter(
    pick => pick.price != null && pick.price > 0
  ).length;
  const remainingBudget = settings.budget - totalSpent;
  const remainingAuctionPicks = Math.max(0, settings.paidAuctionSlots - auctionPicksMade);
  const maxBid = remainingAuctionPicks <= 0
    ? 0
    : Math.max(0, remainingBudget - settings.minimumBid * (remainingAuctionPicks - 1));

  return {
    totalSpent,
    remainingBudget,
    remainingAuctionPicks,
    maxBid,
  };
}
