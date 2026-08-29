'use client';

import { useMemo } from 'react';
import { useAuction } from '@/contexts/auction-context';
import { useNavigation } from '@/contexts/navigation-context';
import { useAllDraftPicks } from '@/hooks/use-draft-picks';
import { useAuctionTeams } from '@/hooks/use-fantasy-teams';
import { useLeague, useUserTeamId } from '@/hooks/use-league';
import {
  getUpcomingTeamPicks,
  mapPicksToRowIndices,
  type ProjectedTeamPick,
} from '@/lib/snake-pick-projection';
import type { Player } from '@/server/types/player';

// Sleeper-style projection lines: for each of the signed-in member's remaining
// snake turns, a divider drawn where the board is expected to be by then, so
// the players above a line are the ones plausibly still there at that pick.
// The projection is "picks come off the top of the board in rank order" — the
// same naive assumption the commercial platforms make.
export function useProjectedPickLines(
  visiblePlayers: Player[],
  draftedPlayerIds: Set<string>,
  isFiltered: boolean,
): Map<number, ProjectedTeamPick> {
  const { isReadOnly } = useAuction();
  const { isSnakeMode } = useNavigation();
  const { data: draftPicks = [] } = useAllDraftPicks();
  const { data: teams = [] } = useAuctionTeams();
  const { settings } = useLeague();
  const userTeamId = useUserTeamId();

  const upcoming = useMemo(() => {
    if (isReadOnly || !isSnakeMode) return [];
    return getUpcomingTeamPicks({
      teams,
      totalPicks: draftPicks.length,
      teamId: userTeamId,
      totalRounds: settings.starterPositions.length + settings.benchSize,
      paidAuctionSlots: settings.paidAuctionSlots,
    });
  }, [isReadOnly, isSnakeMode, teams, draftPicks.length, userTeamId, settings]);

  return useMemo(() => {
    // A position filter or search shows a slice of the board, so "N players
    // from here" no longer maps to N picks — the lines would lie. Drop them
    // rather than draw them somewhere defensible-looking but wrong.
    if (isFiltered) return new Map<number, ProjectedTeamPick>();
    return mapPicksToRowIndices(
      visiblePlayers,
      player => draftedPlayerIds.has(player.id),
      upcoming,
    );
  }, [visiblePlayers, draftedPlayerIds, isFiltered, upcoming]);
}
