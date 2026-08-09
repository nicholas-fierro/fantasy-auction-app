'use client';

import { useMemo, useState } from 'react';
import { useAllDraftPicks } from '@/hooks/use-draft-picks';
import { useAuctionTeams } from '@/hooks/use-fantasy-teams';
import { useAuction } from '@/contexts/auction-context';
import { DraftPickCell } from '@/components/draft-pick-cell';
import { SnakeDraftPickModal } from '@/components/snake-draft-pick-modal';
import { DraftPickWithDetails } from '@/server/types/draft-pick';
import { FantasyTeam } from '@/server/types/fantasy-team';
import { useNavigation } from '@/contexts/navigation-context';
import { calculateCurrentSnakeTeam, getTeamRoundForPick } from '@/lib/snake-draft';
import { isUserTeam } from '@/lib/roster';
import { useDraftRole, useLeague } from '@/hooks/use-league';
import { useMockDraft } from '@/contexts/mock-draft-context';
import { Loader2 } from 'lucide-react';
import { PageHeader } from '@/components/page-header';
import { PageContainer } from '@/components/page-container';

export function DraftBoard({ embedded }: { embedded?: boolean }) {
  const { data: draftPicks = [], isLoading: picksLoading } = useAllDraftPicks();
  const { data: teams = [], isLoading: teamsLoading } = useAuctionTeams();
  const { isSnakeMode } = useNavigation();
  const { isReadOnly } = useAuction();
  const mockDraft = useMockDraft();
  const { canPickAnyTeam, userTeamId } = useDraftRole();
  const { settings } = useLeague();
  const [snakePickModal, setSnakePickModal] = useState<{
    isOpen: boolean;
    team: FantasyTeam | null;
    pickOrder: number;
  }>({ isOpen: false, team: null, pickOrder: 0 });

  // Create a grid structure for the draft board
  const draftGrid = useMemo(() => {
    if (!teams.length) return null;

    // Sort teams by draft order
    const sortedTeams = [...teams].sort((a, b) => a.draft_order - b.draft_order);

    // Sort picks by pick order (chronological)
    const sortedPicks = [...draftPicks].sort((a, b) => a.pick_order - b.pick_order);

    // Row count: default roster size, or however many picks a team actually
    // has (whichever is bigger) — so an in-progress draft still shows empty
    // future rounds and a completed draft with extra picks isn't truncated.
    const defaultRounds = settings.starterPositions.length + settings.benchSize;
    const picksPerTeam = new Map<string, number>();
    sortedPicks.forEach(p => picksPerTeam.set(p.fantasy_team_id, (picksPerTeam.get(p.fantasy_team_id) ?? 0) + 1));
    const rows = Math.max(defaultRounds, 0, ...picksPerTeam.values());

    // Create grid: [round][team] = pick
    const grid: (DraftPickWithDetails | null)[][] = Array(rows).fill(null).map(() =>
      Array(sortedTeams.length).fill(null)
    );

    // Fill the grid with picks based on team ownership and team's pick sequence
    sortedPicks.forEach((pick) => {
      // Find the team's position in the sorted teams array
      const teamIndex = sortedTeams.findIndex(team => team.id === pick.fantasy_team_id);

      if (teamIndex !== -1) {
        // Get all picks for this team, sorted chronologically by pick_order
        const teamPicks = sortedPicks
          .filter(p => p.fantasy_team_id === pick.fantasy_team_id)
          .sort((a, b) => a.pick_order - b.pick_order);

        // Find this pick's sequence number for the team (0-based)
        const teamPickSequence = teamPicks.findIndex(p => p.id === pick.id);

        // The round is determined by the team's pick sequence (1st pick = round 0, 2nd pick = round 1, etc.)
        if (teamPickSequence !== -1 && teamPickSequence < rows && teamIndex < sortedTeams.length) {
          grid[teamPickSequence][teamIndex] = pick;
        }
      }
    });

    return { grid, sortedTeams, rows };
  }, [teams, draftPicks, settings.starterPositions.length, settings.benchSize]);

  // Calculate snake draft team queue
  const snakeTeamQueue = useMemo(() => {
    return calculateCurrentSnakeTeam(
      teams,
      draftPicks.length,
      settings.paidAuctionSlots,
    );
  }, [teams, draftPicks.length, settings.paidAuctionSlots]);

  // Handle cell click for snake draft
  const handleCellClick = (teamIndex: number, round: number) => {
    if (!isSnakeMode || isReadOnly || !draftGrid) return;

    const { sortedTeams } = draftGrid;
    const team = sortedTeams[teamIndex];

    // Sim: only the user's own turn is clickable. Live drafts: the admin lane
    // clicks any team's cell; a member only their own team's.
    if (mockDraft.isActive && !isUserTeam(team, userTeamId)) return;
    if (!mockDraft.isActive && !canPickAnyTeam && !isUserTeam(team, userTeamId)) return;

    // Only allow clicks on the current team's turn and their next round
    if (snakeTeamQueue.currentTeam?.id !== team.id) return;

    // Check if this is the team's next pick round
    const teamPickCount = getTeamRoundForPick(team.id, draftPicks) - 1; // 0-based
    if (round !== teamPickCount) return;

    const pickOrder = draftPicks.length + 1;
    setSnakePickModal({
      isOpen: true,
      team,
      pickOrder
    });
  };

  const handleSnakePickSuccess = () => {
    setSnakePickModal({ isOpen: false, team: null, pickOrder: 0 });
  };

  if (picksLoading || teamsLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-8 w-8 animate-spin text-blue-600" />
        <span className="ml-2 text-gray-600 dark:text-gray-400">Loading draft board...</span>
      </div>
    );
  }

  if (!draftGrid?.grid) {
    return (
      <div className="flex items-center justify-center h-full text-gray-500 dark:text-gray-400">
        No draft data available
      </div>
    );
  }

  const { grid, sortedTeams, rows } = draftGrid;

  const board = (
    <>
      {!embedded && (
        <PageHeader
          title="Draft Board"
          description={`Track live draft picks across all ${sortedTeams.length} teams and ${rows} rounds`}
          className="mb-3 max-md:shrink-0"
        />
      )}

      {/* Below md the board is the vertical scroller too (see the flex chain in
          draft-board-view), so the team header row can stick to the top and the
          round column to the left while the 12 columns scroll horizontally. */}
      <div className="overflow-x-auto rounded-xl border border-stone-200 bg-white p-2.5 shadow-sm max-md:min-h-0 max-md:flex-1 max-md:pl-0 dark:border-gray-700 dark:bg-gray-950">
        <div className="min-w-[1240px]">
          {/* Header Row with Team Names */}
          <div
            className="mb-[3px] grid gap-[3px] max-md:sticky max-md:top-0 max-md:z-20 max-md:mb-0 max-md:bg-white max-md:pb-[3px] max-md:dark:bg-gray-950"
            style={{ gridTemplateColumns: `30px repeat(${sortedTeams.length}, minmax(0, 1fr))` }}
          >
            {/* Empty space for round numbers (w-33 on mobile covers the 3px gap
                the columns would otherwise slide through). */}
            <div className="max-md:sticky max-md:left-0 max-md:z-10 max-md:w-[33px] max-md:bg-white max-md:dark:bg-gray-950"></div>
            {sortedTeams.map((team: FantasyTeam) => {
              const isUsersTeam = isUserTeam(team, userTeamId);

              return (
                <div
                  key={team.id}
                  className={isUsersTeam
                    ? 'flex min-w-0 items-center gap-1 rounded-md border border-stone-800 bg-stone-800 px-[7px] py-1 text-white'
                    : 'flex min-w-0 items-center gap-1 rounded-md border border-gray-200 bg-gray-100 px-[7px] py-1 text-stone-800 dark:border-gray-600 dark:bg-gray-700 dark:text-white'}
                >
                  <span className="min-w-0 flex-1 truncate text-[11px] font-semibold">{team.name}</span>
                  <span className={isUsersTeam
                    ? 'shrink-0 text-[9px] text-white/60'
                    : 'shrink-0 text-[9px] text-stone-400 dark:text-gray-300'}
                  >
                    #{team.draft_order}
                  </span>
                </div>
              );
            })}
          </div>

          {/* Draft Grid */}
          {Array.from({ length: rows }, (_, round) => (
            <div key={round} className="mb-[3px] grid gap-[3px] last:mb-0" style={{ gridTemplateColumns: `30px repeat(${sortedTeams.length}, minmax(0, 1fr))` }}>
              {/* Round Number */}
              <div className="flex h-[46px] items-center justify-center text-[10px] font-semibold text-stone-400 max-md:sticky max-md:left-0 max-md:z-10 max-md:w-[33px] max-md:bg-white dark:text-gray-400 max-md:dark:bg-gray-950">
                R{round + 1}
              </div>

              {/* Draft Picks for this round */}
              {Array.from({ length: sortedTeams.length }, (_, teamIndex) => {
                const pick = grid[round][teamIndex];
                const team = sortedTeams[teamIndex];

                // Determine cell highlighting for snake mode
                let cellClassName = "h-[46px]";
                let isClickable = false;

                if (isSnakeMode && !isReadOnly && !pick && team) {
                  const teamPickCount = getTeamRoundForPick(team.id, draftPicks) - 1; // 0-based

                  // Check if this is the current team's next pick
                  if (
                    snakeTeamQueue.currentTeam?.id === team.id &&
                    round === teamPickCount &&
                    (!mockDraft.isActive || isUserTeam(team, userTeamId)) &&
                    (mockDraft.isActive || canPickAnyTeam || isUserTeam(team, userTeamId))
                  ) {
                    cellClassName += " ring-2 ring-blue-500 ring-offset-1 cursor-pointer hover:ring-blue-600 transition-all";
                    isClickable = true;
                  }
                  // Check if this is the next team's upcoming pick
                  else if (snakeTeamQueue.nextTeam?.id === team.id && round === teamPickCount) {
                    cellClassName += " ring-2 ring-yellow-400 ring-offset-1";
                  }
                }

                return (
                  <div
                    key={teamIndex}
                    className=""
                    onClick={() => isClickable ? handleCellClick(teamIndex, round) : undefined}
                  >
                    <DraftPickCell
                      draftPick={pick || undefined}
                      className={cellClassName}
                    />
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>

      {/* Snake Draft Pick Modal */}
      {snakePickModal.team && (
        <SnakeDraftPickModal
          isOpen={snakePickModal.isOpen}
          onClose={() => setSnakePickModal({ isOpen: false, team: null, pickOrder: 0 })}
          team={snakePickModal.team}
          pickOrder={snakePickModal.pickOrder}
          onSuccess={handleSnakePickSuccess}
        />
      )}
    </>
  );

  if (embedded) return board;

  return (
    <PageContainer className="overflow-auto max-md:flex max-md:min-h-0 max-md:flex-1 max-md:flex-col max-md:overflow-hidden">
      {board}
    </PageContainer>
  );
}
