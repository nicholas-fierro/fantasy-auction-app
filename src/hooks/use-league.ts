'use client';

import { useAuction } from '@/contexts/auction-context';
import { useLeagueContext } from '@/contexts/league-context';
import type { LeagueInfo } from '@/lib/league';
import { pb } from '@/lib/pb-client';
import type { RosterSettings } from '@/lib/roster';

export type { LeagueInfo, LeagueMembership } from '@/lib/league';

export function useLeague(): {
  league: LeagueInfo | null;
  settings: RosterSettings;
  isCommissioner: boolean;
} {
  const { selectedLeague, settings, isCommissioner } = useLeagueContext();
  return { league: selectedLeague, settings, isCommissioner };
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
