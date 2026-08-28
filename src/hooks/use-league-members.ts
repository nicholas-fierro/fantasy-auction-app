'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { pb } from '@/lib/pb-client';
import type { RosterSettings } from '@/lib/roster';

// Commissioner admin mutations kept out of use-invites.ts to avoid churning it:
// member team assignment/removal, league-settings edits, and the active-draft
// lock that gates settings edits. All are authorized by the league_members /
// leagues update+delete rules (commissioner = @request.auth.id); these hooks
// just read and write.

// Reassign (or clear) a member's fantasy_team. Passing an empty/undefined team
// unbinds them. Invalidates both the members list and the per-user membership
// query useUserTeamId reads.
export function useUpdateLeagueMember(leagueId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (values: { id: string; fantasy_team: string | null }) => {
      return pb.collection('league_members').update(values.id, {
        fantasy_team: values.fantasy_team || null,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['league-members', leagueId] });
      queryClient.invalidateQueries({ queryKey: ['league-membership'] });
    },
  });
}

export function useDeleteLeagueMember(leagueId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await pb.collection('league_members').delete(id);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['league-members', leagueId] });
      queryClient.invalidateQueries({ queryKey: ['league-membership'] });
    },
  });
}

// Persist edited league settings. League queries merge leagues.settings over
// DEFAULT_ROSTER_SETTINGS, so writing a full RosterSettings blob is safe. Refresh
// both auction-scoped and commissioner-scoped league caches after saving.
export function useUpdateLeagueSettings(leagueId: string | null) {
  const queryClient = useQueryClient();
  const userId = pb.authStore.record?.id ?? null;
  return useMutation({
    mutationFn: async (settings: RosterSettings) => {
      if (!leagueId) throw new Error('No league selected');
      return pb.collection('leagues').update(leagueId, { settings });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['league', leagueId] });
      queryClient.invalidateQueries({ queryKey: ['commissioner-league', userId] });
    },
  });
}

// Whether the league currently has a live draft. Settings edits are disabled
// while one is running so mid-draft budget/roster changes can't invalidate picks.
export function useHasActiveAuction(leagueId: string | null): boolean {
  const { data } = useQuery({
    queryKey: ['active-auction', leagueId],
    queryFn: async (): Promise<boolean> => {
      const rows = await pb.collection('auctions').getList(1, 1, {
        filter: pb.filter(
          'league = {:leagueId} && status = "active"',
          { leagueId }
        ),
      });
      return rows.items.length > 0;
    },
    enabled: !!leagueId,
  });
  return data ?? false;
}
