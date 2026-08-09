'use client';

import { useQuery } from '@tanstack/react-query';
import type { DraftComparison } from '@/lib/draft-comparison';
import type { Player } from '@/server/types/player';

interface CompareResponse {
  comparison: DraftComparison | null;
  unavailable?: string;
}

export function useFantasyProsComparison(players: readonly [Player | undefined, Player | undefined]) {
  const [first, second] = players;
  const mapped = Boolean(first?.fantasypros_id && second?.fantasypros_id);

  return useQuery({
    queryKey: ['fantasypros-comparison', first?.id, second?.id, first?.fantasypros_id, second?.fantasypros_id],
    enabled: Boolean(first && second && mapped),
    staleTime: 1000 * 60 * 30,
    // The view holds a loading state (no local fallback) while this query is
    // in flight, so fail fast rather than sitting through retry backoff.
    retry: 1,
    queryFn: async (): Promise<CompareResponse> => {
      if (!first || !second) return { comparison: null };
      // Only local player ids are sent; the API resolves name/position/
      // FantasyPros id server-side from the database.
      const query = new URLSearchParams({ p1: first.id, p2: second.id });
      const response = await fetch(`/api/fantasypros/compare?${query}`);
      const body = await response.json() as CompareResponse & { error?: string };
      if (!response.ok) throw new Error(body.error || 'Unable to load FantasyPros comparison.');
      return body;
    },
  });
}
