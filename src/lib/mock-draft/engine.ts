// Phase & turn derivation for a mock draft, plus assembly of per-team live state.
// Everything here is derived purely from the picks recorded so far (ordinary
// draft_picks rows) + the auction's teams, so a page refresh resumes the draft at
// exactly the right point with no transient state persisted.

import type { DraftPickWithDetails } from '@/server/types/draft-pick';
import type { FantasyTeam } from '@/server/types/fantasy-team';
import {
  DEFAULT_ROSTER_SETTINGS,
  buildRosterFromPicks,
  calculateBudgetSummary,
  type RosterSettings,
} from '@/lib/roster';
import { getNominatorForPick } from '@/lib/draft-turn';
import { calculateCurrentSnakeTeam } from '@/lib/snake-draft';
import { NEUTRAL_PROFILE } from './profiles';
import { MockDraftState, TeamProfile, TeamState } from './types';

// Derive the current phase and whose turn it is from the picks made so far.
export function deriveMockDraftState(
  picks: DraftPickWithDetails[],
  teams: FantasyTeam[],
  settings: RosterSettings = DEFAULT_ROSTER_SETTINGS
): MockDraftState {
  const teamsCount = teams.length;
  const nextPickOrder = picks.length + 1;
  const auctionTotal = settings.paidAuctionSlots * teamsCount;
  const totalPicks =
    (settings.starterPositions.length + settings.benchSize) * teamsCount;

  if (picks.length >= totalPicks) {
    return { phase: 'complete', currentTeamId: null, nextPickOrder };
  }

  if (nextPickOrder <= auctionTotal) {
    return {
      phase: 'auction',
      currentTeamId: getNominatorForPick(
        picks.length,
        picks,
        teams,
        settings.paidAuctionSlots
      ),
      nextPickOrder,
    };
  }

  const { currentTeam } = calculateCurrentSnakeTeam(
    teams,
    picks.length,
    settings.paidAuctionSlots
  );
  return { phase: 'snake', currentTeamId: currentTeam?.id ?? null, nextPickOrder };
}

// Assemble the live TeamState for every team from the picks so far and the
// precomputed profiles. Picks are grouped by team; roster/budget math reuses the
// shared roster.ts helpers.
export function buildTeamStates(
  picks: DraftPickWithDetails[],
  teams: FantasyTeam[],
  profiles: Map<string, TeamProfile>,
  settings: RosterSettings = DEFAULT_ROSTER_SETTINGS
): Map<string, TeamState> {
  const picksByTeam = new Map<string, DraftPickWithDetails[]>();
  for (const t of teams) picksByTeam.set(t.id, []);
  for (const pick of picks) {
    const list = picksByTeam.get(pick.fantasy_team_id);
    if (list) list.push(pick);
  }

  const states = new Map<string, TeamState>();
  for (const team of teams) {
    const teamPicks = picksByTeam.get(team.id) ?? [];
    const budget = calculateBudgetSummary(teamPicks, settings);
    const roster = buildRosterFromPicks(teamPicks, settings);

    const spentByPosition: Record<string, number> = {};
    const countByPosition: Record<string, number> = {};
    for (const pick of teamPicks) {
      const pos = pick.player.position;
      countByPosition[pos] = (countByPosition[pos] ?? 0) + 1;
      if (pick.price != null && pick.price > 0) {
        spentByPosition[pos] = (spentByPosition[pos] ?? 0) + pick.price;
      }
    }

    const filledStarters: Record<string, number> = {};
    let filledFlexStarters = 0;
    let unfilledRequiredStarters = 0;
    for (const slot of roster.starters) {
      if (slot.player) {
        if (slot.position === 'FLEX') filledFlexStarters++;
        else filledStarters[slot.position] = (filledStarters[slot.position] ?? 0) + 1;
      } else {
        unfilledRequiredStarters++;
      }
    }

    const profile = profiles.get(team.id);
    states.set(team.id, {
      teamId: team.id,
      profile: profile ?? {
        teamId: team.id,
        ...NEUTRAL_PROFILE,
        sampleSize: 0,
        snakeSampleSize: 0,
        affinitySampleSize: 0,
      },
      maxBid: budget.maxBid,
      remainingBudget: budget.remainingBudget,
      remainingAuctionPicks: budget.remainingAuctionPicks,
      totalPicks: teamPicks.length,
      spentByPosition,
      countByPosition,
      filledStarters,
      filledFlexStarters,
      unfilledRequiredStarters,
    });
  }

  return states;
}
