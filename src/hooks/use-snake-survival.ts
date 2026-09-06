'use client';

import { useAllDraftPicks } from '@/hooks/use-draft-picks';
import { useAuctionTeams } from '@/hooks/use-fantasy-teams';
import { useIsSnakeLeague, useUserTeamId } from '@/hooks/use-league';
import { useAllPlayers } from '@/hooks/use-players';
import { deriveAdp } from '@/lib/adp';
import { picksUntilNextTurn } from '@/lib/snake-survival';

// One shared survival-signal predicate (NFI-83): whether the column shows,
// how many picks until the user's next turn, and the overall pick about to be
// made. ADP availability is a property of the league's full board — deriving
// it per visible list let the players table and the watchlist disagree.
export function useSnakeSurvival(): {
  showSurvival: boolean;
  picksAway: number | null;
  currentOverall: number;
} {
  const { data: players = [] } = useAllPlayers();
  const { data: draftPicks = [] } = useAllDraftPicks();
  const { data: teams = [] } = useAuctionTeams();
  const userTeamId = useUserTeamId();
  const isSnakeLeague = useIsSnakeLeague();

  const adpAvailable = players.some(
    (player) => deriveAdp(player.rank, player.ecr_vs_adp) != null
  );
  const userDraftOrder = teams.find((team) => team.id === userTeamId)?.draft_order ?? null;
  const picksAway = isSnakeLeague && userTeamId
    ? picksUntilNextTurn(draftPicks.length, userDraftOrder, teams.length)
    : null;
  // Suppressed on the user's own turn (picksAway 0): the question doesn't
  // apply while picking, and the predicate returns null there anyway.
  const showSurvival = isSnakeLeague && adpAvailable && picksAway != null && picksAway > 0;
  return { showSurvival, picksAway, currentOverall: draftPicks.length + 1 };
}
