'use client';

import { useQuery } from '@tanstack/react-query';
import type { RecordModel } from 'pocketbase';
import { pb } from '@/lib/pb-client';
import { useAuction } from '@/contexts/auction-context';
import { DEFAULT_ROSTER_SETTINGS, type RosterSettings } from '@/lib/roster';
import { isScoringFormat } from '@/lib/fantasy-scoring';

// Draft context uses the selected auction's league; commissioner admin context
// resolves its league directly so it remains available without a selected draft.
// Legacy auctions without a league (or a signed-in user without a membership)
// degrade gracefully: default settings, no user team, not commissioner.

export interface LeagueInfo {
  id: string;
  name: string;
  commissioner: string;
  settings: RosterSettings;
}

function mapLeagueRecord(record: RecordModel): LeagueInfo {
  // Unknown/missing keys fall back field-by-field so a partial settings blob
  // can't produce a half-configured league.
  const settings: RosterSettings = {
    ...DEFAULT_ROSTER_SETTINGS,
    ...(record.settings ?? {}),
  };

  return {
    id: record.id,
    name: record.name,
    commissioner: record.commissioner,
    settings: {
      ...settings,
      // An unrecognized format would reach scoring as an undefined multiplier
      // and silently turn every points column into NaN.
      scoringFormat: isScoringFormat(settings.scoringFormat)
        ? settings.scoringFormat
        : DEFAULT_ROSTER_SETTINGS.scoringFormat,
    },
  };
}

export function useLeague(): {
  league: LeagueInfo | null;
  settings: RosterSettings;
  isCommissioner: boolean;
} {
  const { selectedAuction } = useAuction();
  const leagueId = selectedAuction?.league ?? null;

  const { data } = useQuery({
    queryKey: ['league', leagueId],
    queryFn: async (): Promise<LeagueInfo> => {
      const record = await pb.collection('leagues').getOne(leagueId!);
      return mapLeagueRecord(record);
    },
    enabled: !!leagueId,
    staleTime: 5 * 60 * 1000, // league config changes rarely
  });

  const userId = pb.authStore.record?.id ?? null;
  return {
    league: data ?? null,
    settings: data?.settings ?? DEFAULT_ROSTER_SETTINGS,
    isCommissioner: !!data && !!userId && data.commissioner === userId,
  };
}

// League-level commissioner check, independent of any selected auction. Use
// this for league-admin surfaces (Settings tabs) that exist whether or not a
// draft is active — useLeague().isCommissioner is auction-scoped and goes false
// with no auction selected. A user commissions at most one league (leagues
// listRule allows `commissioner = @request.auth.id`).
export function useCommissionerLeague(): {
  league: LeagueInfo | null;
  settings: RosterSettings;
} {
  const userId = pb.authStore.record?.id ?? null;
  const { data } = useQuery({
    queryKey: ['commissioner-league', userId],
    queryFn: async (): Promise<LeagueInfo | null> => {
      const rows = await pb.collection('leagues').getList(1, 1, {
        filter: pb.filter('commissioner = {:userId}', { userId }),
      });
      const record = rows.items[0];
      return record ? mapLeagueRecord(record) : null;
    },
    enabled: !!userId,
    staleTime: 5 * 60 * 1000,
  });

  return {
    league: data ?? null,
    settings: data?.settings ?? DEFAULT_ROSTER_SETTINGS,
  };
}

// Boolean convenience for commissioner-only surfaces.
export function useIsCommissioner(): boolean {
  const { league } = useCommissionerLeague();
  return !!league;
}

// The signed-in user's fantasy team in the selected auction's league, from
// their league_members row. Null while loading, without a membership, or for
// legacy auctions with no league.
export function useUserTeamId(): string | null {
  const { selectedAuction } = useAuction();
  const leagueId = selectedAuction?.league ?? null;
  const userId = pb.authStore.record?.id ?? null;

  const { data } = useQuery({
    queryKey: ['league-membership', leagueId, userId],
    queryFn: async (): Promise<string | null> => {
      const rows = await pb.collection('league_members').getList(1, 1, {
        filter: pb.filter('league = {:leagueId} && user = {:userId}', { leagueId, userId }),
      });
      return rows.items[0]?.fantasy_team || null;
    },
    enabled: !!leagueId && !!userId,
    staleTime: 5 * 60 * 1000,
  });

  return data ?? null;
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
  const { isCommissioner } = useLeague();
  const userTeamId = useUserTeamId();
  const userId = pb.authStore.record?.id ?? null;
  const isOwner = !!selectedAuction && !!userId && selectedAuction.user === userId;
  return { canPickAnyTeam: isOwner || isCommissioner, userTeamId };
}
