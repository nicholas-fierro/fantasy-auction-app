'use client';

import { useAuction } from '@/contexts/auction-context';
import { useNavigation } from '@/contexts/navigation-context';
import { useAllDraftPicks } from '@/hooks/use-draft-picks';
import { useAuctionTeams } from '@/hooks/use-fantasy-teams';
import { useLeague, useUserTeamId } from '@/hooks/use-league';
import { getNominatorForPick } from '@/lib/draft-turn';
import { calculateCurrentSnakeTeam } from '@/lib/snake-draft';

export interface OnTheClockState {
  onTheClock: boolean;
  message: string;
  // "Up next" is a softer heads-up: not the signed-in member's turn yet, but
  // it will be immediately after the current pick/nomination resolves.
  upNext: boolean;
  upNextMessage: string;
}

const IDLE_STATE: OnTheClockState = { onTheClock: false, message: '', upNext: false, upNextMessage: '' };

// Shared turn-state derivation for the ticker turn segment and useTurnNotifications
// (3d) — a single source so the ticker segment and the chime/title-flash
// notification never disagree about whose turn it is. Snake turn is exact
// (pick count + draft order); auction "up" means the nomination rotation
// (draft_order cycle, AD-14) — the pick itself belongs to whoever wins the
// bidding. Nomination and snake turns are both enforced by PocketBase hooks;
// this only mirrors that state for the UI.
export function useOnTheClockState(): OnTheClockState {
  const { isReadOnly } = useAuction();
  const { isSnakeMode } = useNavigation();
  const { data: draftPicks = [] } = useAllDraftPicks();
  const { data: teams = [] } = useAuctionTeams();
  const { settings } = useLeague();
  const userTeamId = useUserTeamId();

  if (isReadOnly || !userTeamId || teams.length === 0) return IDLE_STATE;

  if (isSnakeMode) {
    const { currentTeam, nextTeam } = calculateCurrentSnakeTeam(
      teams,
      draftPicks.length,
      settings.paidAuctionSlots,
    );
    if (currentTeam?.id === userTeamId) {
      return { onTheClock: true, message: "You're on the clock — pick a player", upNext: false, upNextMessage: '' };
    }
    if (nextTeam?.id === userTeamId) {
      return { onTheClock: false, message: '', upNext: true, upNextMessage: "You're up next — get ready to pick" };
    }
    return IDLE_STATE;
  }

  const nominatorTeamId = getNominatorForPick(
    draftPicks.length,
    draftPicks,
    teams,
    settings.paidAuctionSlots,
  );
  if (nominatorTeamId === userTeamId) {
    return { onTheClock: true, message: 'Your turn to nominate', upNext: false, upNextMessage: '' };
  }

  const nextNominatorTeamId = getNominatorForPick(
    draftPicks.length + 1,
    draftPicks,
    teams,
    settings.paidAuctionSlots,
  );
  if (nextNominatorTeamId === userTeamId) {
    return { onTheClock: false, message: '', upNext: true, upNextMessage: "You're up next to nominate" };
  }

  return IDLE_STATE;
}
