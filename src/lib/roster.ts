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
//
// Counterpart: the settings block of POST /api/league-admin/create-league in
// pb_hooks/league_admin_routes.pb.js enforces the same rules server-side. The
// hook runs in PB's JSVM and cannot import this, so keep the two aligned by
// hand — the bounds below mirror that block one for one.
export const ROSTER_POSITION_ENUM = ['QB', 'RB', 'WR', 'TE', 'FLEX', 'K', 'DST'] as const;

export function validateRosterSettings(settings: RosterSettings): string | null {
  if (!isDraftFormat(settings.draftFormat)) {
    return 'Choose a valid draft format';
  }

  const isSnake = settings.draftFormat === 'snake';
  if (!Number.isFinite(settings.budget) || (isSnake ? settings.budget < 0 : settings.budget <= 0) || settings.budget > 1000000) {
    return isSnake ? 'Budget must be a non-negative number up to 1000000' : 'Budget must be a positive number up to 1000000';
  }
  if (!Number.isInteger(settings.paidAuctionSlots) || (isSnake ? settings.paidAuctionSlots !== 0 : settings.paidAuctionSlots <= 0)) {
    return isSnake ? 'Snake drafts must have zero paid slots' : 'Paid slots must be a positive integer';
  }
  if (!Number.isFinite(settings.minimumBid) || settings.minimumBid < (isSnake ? 0 : 1) || settings.minimumBid > 1000000) {
    return isSnake ? 'Minimum bid must be a non-negative number up to 1000000' : 'Minimum bid must be at least $1 and at most 1000000';
  }
  if (!Number.isInteger(settings.benchSize) || settings.benchSize < 0 || settings.benchSize > 50) {
    return 'Bench size must be an integer from 0 to 50';
  }
  if (!Array.isArray(settings.starterPositions) || settings.starterPositions.length < 1 || settings.starterPositions.length > 50 ||
    settings.starterPositions.some((p) => !(ROSTER_POSITION_ENUM as readonly string[]).includes(p))) {
    return 'Use 1–50 starter positions: QB, RB, WR, TE, FLEX, K, DST.';
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
