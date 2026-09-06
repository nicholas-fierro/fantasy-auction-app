'use client';

import { useAuction } from '@/contexts/auction-context';
import { useLeagueContext } from '@/contexts/league-context';
import type { LeagueInfo } from '@/lib/league';
import { pb } from '@/lib/pb-client';
import type { DraftFormat, RosterSettings } from '@/lib/roster';

export type { LeagueInfo, LeagueMembership } from '@/lib/league';

export function useLeague(): {
  league: LeagueInfo | null;
  settings: RosterSettings;
  isCommissioner: boolean;
} {
  const { selectedLeague, settings, isCommissioner } = useLeagueContext();
  return { league: selectedLeague, settings, isCommissioner };
}

export function useDraftFormat(): DraftFormat {
  return useLeagueContext().format;
}

// Single predicate gating every piece of auction chrome in a snake-format
// league (NFI-82): budget/max-bid summaries, nomination UI + subscription,
// price entry, and price columns. Derived from the league's declared draft
// format — never from phase state (isSnakeMode) or paidAuctionSlots — so
// hybrid snake-phase rooms keep auction chrome and the gates cannot drift
// apart per component. Not listed: the sim's auction bid controls and the
// watchlist market nudge need no gating — a snake league's sim never enters
// the auction phase (zero paid slots), so those branches are structurally
// unreachable there rather than predicate-gated.
export function useIsSnakeLeague(): boolean {
  return useDraftFormat() === 'snake';
}

export function useCommissionedLeagues(): LeagueInfo[] {
  const { leagues } = useLeagueContext();
  const userId = pb.authStore.record?.id ?? null;
  return leagues.filter(league => league.commissioner === userId);
}

export function useIsCommissionerOf(leagueId: string | null): boolean {
  const commissionedLeagues = useCommissionedLeagues();
  return !!leagueId && commissionedLeagues.some(league => league.id === leagueId);
}

export function useIsCommissioner(): boolean {
  return useLeagueContext().isCommissioner;
}

export function useUserTeamId(): string | null {
  return useLeagueContext().selectedMembership?.fantasyTeamId ?? null;
}

// Role for pick entry in the selected auction (docs/multi-user-plan.md):
// the auction's owner and the league commissioner enter picks for ANY team
// (they run the draft, covering teams not using the app); everyone else is
// limited to the team their membership binds them to. The PB draft_picks
// create rule enforces the same two lanes server-side — this hook only
// shapes the UI.
export function useDraftRole(): {
  canPickAnyTeam: boolean;
  userTeamId: string | null;
} {
  const { selectedAuction } = useAuction();
  const { isCommissioner, selectedMembership } = useLeagueContext();
  const userId = pb.authStore.record?.id ?? null;
  const isOwner = !!selectedAuction && !!userId && selectedAuction.user === userId;
  return {
    canPickAnyTeam: isOwner || isCommissioner,
    userTeamId: selectedMembership?.fantasyTeamId ?? null,
  };
}
