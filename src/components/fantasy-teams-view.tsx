'use client';

import { useEffect, useMemo, useState } from 'react';
import { useAuctionTeams } from '@/hooks/use-fantasy-teams';
import { useAllDraftPicks } from '@/hooks/use-draft-picks';
import { TeamRoster } from './team-roster';
import { RosterViewToggle, type RosterViewMode } from '@/components/team-roster-card';
import { TeamBudgetPressure } from '@/components/team-budget-pressure';
import { PageHeader } from '@/components/page-header';
import { PageContainer } from '@/components/page-container';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { useIsSnakeLeague } from '@/hooks/use-league';

export function FantasyTeamsView() {
  const [rosterView, setRosterView] = useState<RosterViewMode>('slots');
  // Phone-only: one roster at a time, picked from the dropdown. Desktop keeps
  // the full grid, so this is a no-op there.
  const [selectedTeamId, setSelectedTeamId] = useState<string | null>(null);
  const { data: teams = [], isLoading: teamsLoading, error: teamsError } = useAuctionTeams();
  const { data: draftPicks = [], isLoading: picksLoading, error: picksError } = useAllDraftPicks();
  // Budget pressure is auction math — meaningless without prices.
  const isSnakeLeague = useIsSnakeLeague();
  const sortedTeams = useMemo(
    () => [...teams].sort((a, b) => a.draft_order - b.draft_order),
    [teams],
  );

  // Teams arrive async, so the default selection is set once they land — and
  // re-set if the current pick disappears (switching auctions).
  useEffect(() => {
    if (sortedTeams.length === 0) return;
    if (selectedTeamId && sortedTeams.some(team => team.id === selectedTeamId)) return;
    setSelectedTeamId(sortedTeams[0].id);
  }, [sortedTeams, selectedTeamId]);

  if (teamsError || picksError) {
    return (
      <div className="text-center py-8 text-red-600">
        Error loading data: {teamsError?.message || picksError?.message}
      </div>
    );
  }

  if (teamsLoading || picksLoading) {
    return (
      <div className="text-center py-8">
        Loading fantasy teams...
      </div>
    );
  }

  return (
    <PageContainer>
      <PageHeader
        title="Fantasy Team Rosters"
        description="View all team rosters and draft status"
        className="mb-3"
      />

      {!isSnakeLeague && <TeamBudgetPressure teams={sortedTeams} draftPicks={draftPicks} />}

      <div className="mb-2 flex flex-wrap items-center gap-2 md:justify-end">
        <Select value={selectedTeamId ?? undefined} onValueChange={setSelectedTeamId}>
          {/* flex-1, not w-full: a 100%-wide child in a flex-wrap row pushes the
              view toggle onto its own line, which is the clunk this replaced. */}
          <SelectTrigger className="min-w-0 flex-1 md:hidden" aria-label="Select team">
            <SelectValue placeholder="Select a team" />
          </SelectTrigger>
          <SelectContent>
            {sortedTeams.map((team) => (
              <SelectItem key={team.id} value={team.id}>
                #{team.draft_order} · {team.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <RosterViewToggle view={rosterView} onChange={setRosterView} />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-6 gap-2">
        {sortedTeams.map((team) => (
          <div
            key={team.id}
            // Hiding rather than branching on a JS breakpoint keeps one tree:
            // desktop renders every card exactly as it did before.
            className={cn(team.id !== selectedTeamId && 'max-md:hidden')}
          >
            <TeamRoster
              team={team}
              draftPicks={draftPicks.filter(pick => pick.fantasy_team_id === team.id)}
              view={rosterView}
            />
          </div>
        ))}
      </div>
    </PageContainer>
  );
}
