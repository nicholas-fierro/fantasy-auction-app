'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { pb } from '@/lib/pb-client';
import type { LeagueInfo, LeagueMembership } from '@/lib/league';
import type { RosterSettings } from '@/lib/roster';

export interface CreateLeagueInput {
  name: string;
  teamNames: string[];
  commissionerTeamIndex: number;
  settings: RosterSettings;
}

export interface CreatedLeague {
  league: LeagueInfo;
  membership: LeagueMembership;
}

export function useCreateLeague() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateLeagueInput) =>
      pb.send<CreatedLeague>('/api/league-admin/create-league', {
        method: 'POST',
        body: input,
      }),
    onSuccess: (result) => {
      // Seed before selecting: otherwise the context's membership guard can
      // discard the new selection while a background refetch is still running.
      queryClient.setQueryData<{
        leagues: LeagueInfo[];
        memberships: LeagueMembership[];
      }>(['league-memberships', result.membership.userId], (previous) => ({
        leagues: [
          ...(previous?.leagues ?? []).filter(
            (row) => row.id !== result.league.id
          ),
          result.league,
        ],
        memberships: [
          ...(previous?.memberships ?? []).filter(
            (row) => row.id !== result.membership.id
          ),
          result.membership,
        ],
      }));
      void queryClient.invalidateQueries({
        queryKey: ['league-memberships', result.membership.userId],
      });
      void queryClient.invalidateQueries({
        queryKey: ['league-live-draft-counts'],
      });
    },
  });
}
