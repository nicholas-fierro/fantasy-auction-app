'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { pb } from '@/lib/pb-client';
import { computeHistoricalValues } from '@/lib/history-client';
import { loadTeamProfiles } from '@/lib/team-profiles-client';
import { useLeagueContext } from '@/contexts/league-context';

export function useTeamProfiles() {
  const queryClient = useQueryClient();
  const { selectedLeagueId } = useLeagueContext();

  return useQuery({
    queryKey: ['computed-profiles', selectedLeagueId],
    enabled: !!selectedLeagueId,
    staleTime: 1000 * 60 * 60,
    queryFn: async () => {
      if (!selectedLeagueId) return new Map();
      const historicalValues = await queryClient.ensureQueryData({
        queryKey: ['historical-values', selectedLeagueId],
        queryFn: () => computeHistoricalValues(selectedLeagueId),
      });
      return loadTeamProfiles(pb, selectedLeagueId, historicalValues);
    },
  });
}
