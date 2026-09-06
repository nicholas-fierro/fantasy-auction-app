'use client';

import { useQuery } from '@tanstack/react-query';
import { computeHistoricalValues } from '@/lib/history-client';
import { useLeagueContext } from '@/contexts/league-context';

// Historical auction prices change only when an official auction completes or
// value data is imported (both invalidate this key), so it can sit cached for a
// long time. Each league's key spans all its years.
export function useHistoricalValues() {
  const { selectedLeagueId } = useLeagueContext();
  return useQuery({
    queryKey: ['historical-values', selectedLeagueId],
    queryFn: () => computeHistoricalValues(selectedLeagueId!),
    enabled: !!selectedLeagueId,
    staleTime: 1000 * 60 * 60, // 1 hour
  });
}
