'use client';

import { FantasyTeam } from '@/server/types/fantasy-team';
import { DraftPickWithDetails } from '@/server/types/draft-pick';
import { TeamRosterCard, type RosterViewMode } from '@/components/team-roster-card';
import { calculateBudgetSummary } from '@/lib/roster';
import { useLeague } from '@/hooks/use-league';

interface TeamRosterProps {
  team: FantasyTeam;
  draftPicks: DraftPickWithDetails[];
  view: RosterViewMode;
}

export function TeamRoster({ team, draftPicks, view }: TeamRosterProps) {
  const { settings } = useLeague();
  const { remainingBudget, remainingAuctionPicks } = calculateBudgetSummary(draftPicks, settings);

  return (
    <TeamRosterCard
      team={team}
      draftPicks={draftPicks}
      view={view}
      subtitleOverride={`$${remainingBudget} for ${remainingAuctionPicks} picks`}
    />
  );
}
