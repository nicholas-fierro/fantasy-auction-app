'use client';

import { useQuery } from '@tanstack/react-query';
import { computeHistoricalValues } from '@/lib/history-client';

// Historical auction prices change only when an official auction completes or
// value data is imported (both invalidate this key), so it can sit cached for a
// long time. Keyed globally — it spans all years.
export function useHistoricalValues() {
  return useQuery({
    queryKey: ['historical-values'],
    queryFn: computeHistoricalValues,
    staleTime: 1000 * 60 * 60, // 1 hour
  });
}
