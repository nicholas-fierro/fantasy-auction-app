'use client';

import { useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { useAuction } from '@/contexts/auction-context';
import { useNavigation } from '@/contexts/navigation-context';
import { useLeague } from '@/hooks/use-league';
import { useAllDraftPicks } from '@/hooks/use-draft-picks';
import { useAuctionTeams } from '@/hooks/use-fantasy-teams';

// Derives draftMode automatically from league config + LEAGUE-WIDE draft
// progress, replacing the old manual sidebar toggle (issue #15).
//
// The switch is keyed to the SAME condition snake-draft.ts uses to expose a
// current snake team: the auction phase spans paidAuctionSlots picks for EVERY
// team, so snake starts only once total picks reach paidAuctionSlots * teamCount.
// Keying off the signed-in user's own team instead would flip the global UI to
// snake while the owner/commissioner still has other teams' auction picks to
// record — nominations get disabled (snake mode) but the snake buttons are also
// disabled (no current snake team yet), stranding the pick recorder.
//
// Only runs for an active, non-read-only auction — read-only/historical and
// completed auctions keep whatever draftMode they last had, unforced.
export function useAutoDraftMode() {
  const { isReadOnly } = useAuction();
  const { draftMode, setDraftMode } = useNavigation();
  const { settings } = useLeague();
  const { data: draftPicks = [] } = useAllDraftPicks();
  const { data: teams = [] } = useAuctionTeams();

  // Tracks whether we've already toasted for the current auction/mount, so
  // the transition toast fires once per auction->snake switch, not on every
  // render or on initial mount.
  const hasToastedRef = useRef(false);

  useEffect(() => {
    if (isReadOnly) return;
    // Teams not loaded yet — don't flip on an empty roster (auctionPicksTotal
    // would be 0 and every state would read as "snake").
    if (teams.length === 0) return;

    const auctionPicksTotal = settings.paidAuctionSlots * teams.length;
    const targetMode = draftPicks.length >= auctionPicksTotal ? 'snake' : 'auction';

    if (targetMode !== draftMode) {
      if (draftMode === 'auction' && targetMode === 'snake' && !hasToastedRef.current) {
        toast.info('Auction rounds complete — switching to snake draft');
        hasToastedRef.current = true;
      }
      setDraftMode(targetMode);
    }
  }, [isReadOnly, teams.length, draftPicks.length, settings, draftMode, setDraftMode]);

  // Reset the toast guard when we drop back to auction mode (e.g. a new
  // active auction), so a later auction->snake transition can toast again.
  useEffect(() => {
    if (draftMode === 'auction') {
      hasToastedRef.current = false;
    }
  }, [draftMode]);
}
