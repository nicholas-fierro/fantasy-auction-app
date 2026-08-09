'use client';

import { useQuery } from '@tanstack/react-query';
import { pb } from '@/lib/pb-client';
import { mapGameLogRecord } from '@/lib/pb-mappers';
import { GAME_LOG_STAT_KEYS } from '@/lib/game-log-view';

// Only the stat keys the view reads, projected out of the `stats` json column.
// Measured on a full career: 111 KB → 64 KB, and PocketBase does not gzip these
// responses, so it is that many fewer bytes on the wire. See
// GAME_LOG_STAT_KEYS before adding a stat column.
const FIELDS = [
  'id',
  'player_id',
  'season',
  'week',
  'season_type',
  'game_id',
  'team',
  'opponent',
  ...GAME_LOG_STAT_KEYS.map((key) => `stats.${key}`),
].join(',');

// Every game log for one player, across all seasons and both season types.
// Fetched once per player (only while the detail modal is open) so switching
// years or scoring format in the UI costs nothing.
//
// The per-player filter is load bearing. `player_game_logs` holds ~51k rows and
// the collection is read directly from the browser (AD-1); this stays cheap only
// because `player_id` is the leading column of
// idx_player_game_logs_player_season_week, making each read an index seek of
// ~170 rows.
// ponytail: any *cross-player* view — consistency leaderboards, positional
// percentiles — must not reuse this shape. Unfiltered it would pull the whole
// table into the browser; that case needs a PocketBase view collection or a
// server-side aggregate instead.
export function usePlayerGameLogs(playerId: string, enabled = true) {
  return useQuery({
    queryKey: ['player-game-logs', playerId],
    queryFn: async () => {
      const records = await pb.collection('player_game_logs').getFullList({
        filter: pb.filter('player_id = {:playerId}', { playerId }),
        // Not sorted by season_type: 'POST' < 'REG' alphabetically, so SQL would
        // interleave playoff games ahead of the regular season. Callers group the
        // two themselves.
        sort: 'season,week',
        fields: FIELDS,
      });
      return records.map(mapGameLogRecord);
    },
    // Imported historical rows never change under us.
    staleTime: Infinity,
    enabled: enabled && !!playerId,
  });
}
