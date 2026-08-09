'use client';

import { useQuery } from '@tanstack/react-query';
import type { PlayerInjuriesResponse } from '@/lib/sleeper-injuries';

async function fetchPlayerInjuries(): Promise<PlayerInjuriesResponse> {
  const response = await fetch('/api/player-injuries');
  if (!response.ok) throw new Error(`Injury data request failed (${response.status})`);
  return response.json() as Promise<PlayerInjuriesResponse>;
}

export function usePlayerInjuries(enabled = true) {
  return useQuery({
    queryKey: ['player-injuries'],
    queryFn: fetchPlayerInjuries,
    enabled,
    staleTime: 60 * 60 * 1000,
    retry: 1,
  });
}
