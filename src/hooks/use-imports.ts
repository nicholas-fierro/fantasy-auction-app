'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  importRankings,
  importRookies,
  importAuctionValues,
  calculateProjectedValues,
  syncPlayerIds,
} from '@/server/actions/imports';
import {
  ImportInput,
  ImportReport,
  CalculateProjectedResult,
  CalculateProjectedValuesInput,
  PlayerIdSyncReport,
} from '@/server/types/import';

// Imports mutate that year's `player_seasons`, so invalidate the year-keyed
// players + watchlist caches (both are keyed by year in Phase 1's hooks).
function useInvalidateYear() {
  const queryClient = useQueryClient();
  return (year: number) => {
    queryClient.invalidateQueries({ queryKey: ['players', year] });
    queryClient.invalidateQueries({ queryKey: ['watchlist', year] });
    // Imported auction values feed the historical dataset.
    queryClient.invalidateQueries({ queryKey: ['historical-values'] });
    queryClient.invalidateQueries({ queryKey: ['computed-profiles'] });
  };
}

function useImportMutation<TInput extends ImportInput>(
  action: (input: TInput) => Promise<ImportReport>
) {
  const invalidateYear = useInvalidateYear();
  return useMutation({
    mutationFn: (input: TInput) => action(input),
    onSuccess: (_report, input) => invalidateYear(input.year),
  });
}

export function useImportRankings() {
  return useImportMutation(importRankings);
}

export function useImportRookies() {
  return useImportMutation(importRookies);
}

export function useImportAuctionValues() {
  return useImportMutation(importAuctionValues);
}

export function useCalculateProjectedValues() {
  const invalidateYear = useInvalidateYear();
  return useMutation({
    mutationFn: (input: CalculateProjectedValuesInput): Promise<CalculateProjectedResult> =>
      calculateProjectedValues(input),
    onSuccess: (_result, { year }) => invalidateYear(year),
  });
}

// Provider IDs live on `players`, which every year-keyed players query embeds,
// so this invalidates the whole players cache rather than one year.
export function useSyncPlayerIds() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (options: { force?: boolean } = {}): Promise<PlayerIdSyncReport> =>
      syncPlayerIds(options),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['players'] });
      queryClient.invalidateQueries({ queryKey: ['watchlist'] });
    },
  });
}
