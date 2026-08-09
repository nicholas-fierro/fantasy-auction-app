'use client';

import { useQuery } from '@tanstack/react-query';
import { fetchAthleteNews, fetchTeamNews, getEspnTeamId } from '@/lib/espn-news';
import { Player } from '@/server/types/player';

export function usePlayerNews(player: Player, enabled = true) {
  const teamId = getEspnTeamId(player.team);
  const scopeKey = player.espn_id ? `athlete:${player.espn_id}` : `team:${teamId}`;

  return useQuery({
    queryKey: ['player-news', scopeKey],
    queryFn: () => player.espn_id
      ? fetchAthleteNews(player.espn_id)
      : fetchTeamNews(teamId!),
    enabled: enabled && (!!player.espn_id || teamId != null),
    staleTime: 15 * 60 * 1000,
    retry: 1,
  });
}
