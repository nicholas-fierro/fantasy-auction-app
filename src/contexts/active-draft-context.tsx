'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  ReactNode,
} from 'react';
import { useAuction } from '@/contexts/auction-context';
import { useNavigation } from '@/contexts/navigation-context';
import { useLatestAuctionNomination, useCreateAuctionNominationEvent } from '@/hooks/use-auction-nomination';
import { useAllDraftPicks } from '@/hooks/use-draft-picks';
import { useAuctionTeams } from '@/hooks/use-fantasy-teams';
import { useIsSnakeLeague, useLeague, useUserTeamId } from '@/hooks/use-league';
import { useAllPlayers } from '@/hooks/use-players';
import { getActiveNominationPlayerId } from '@/lib/active-nomination';
import {
  canClearOfficialNomination,
  canNominateOfficialPlayer,
  getNominatorForPick,
} from '@/lib/draft-turn';
import { pb } from '@/lib/pb-client';
import { Player } from '@/server/types/player';

interface ActiveDraftContextType {
  activePlayer: Player | null;
  canNominate: boolean;
  canClearActivePlayer: boolean;
  setActivePlayer: (player: Player | null) => void;
}

const ActiveDraftContext = createContext<ActiveDraftContextType | undefined>(undefined);

export function ActiveDraftProvider({ children }: { children: ReactNode }) {
  const { selectedAuction, isReadOnly } = useAuction();
  const { isSnakeMode } = useNavigation();
  // Format-level kill switch: a snake-format league never nominates, even
  // before the phase toggle flips. Hybrid leagues keep phase behavior.
  const isSnakeLeague = useIsSnakeLeague();
  const noNominations = isSnakeLeague || isSnakeMode;
  const { data: players = [] } = useAllPlayers();
  const { data: draftPicks = [] } = useAllDraftPicks();
  const { data: teams = [] } = useAuctionTeams();
  const { isCommissioner, settings } = useLeague();
  const userTeamId = useUserTeamId();
  const { data: latestNomination } = useLatestAuctionNomination();
  const createNominationEvent = useCreateAuctionNominationEvent();
  const [localActivePlayer, setLocalActivePlayer] = useState<Player | null>(null);
  const [pendingSharedPlayer, setPendingSharedPlayer] = useState<{
    auctionId: string;
    requestId: number;
    player: Player | null;
  } | null>(null);
  const requestIdRef = useRef(0);

  const auctionId = selectedAuction?.id ?? null;
  const isSharedOfficialAuction = selectedAuction?.type === 'official';
  const syncedPlayerId = getActiveNominationPlayerId(latestNomination, draftPicks);
  const syncedPlayer = syncedPlayerId
    ? players.find((player) => player.id === syncedPlayerId) ?? null
    : null;
  const optimisticPlayer = pendingSharedPlayer?.auctionId === auctionId
    ? pendingSharedPlayer.player
    : undefined;
  const activePlayer = noNominations || isReadOnly
    ? null
    : isSharedOfficialAuction
      ? optimisticPlayer === undefined ? syncedPlayer : optimisticPlayer
      : localActivePlayer;
  const userId = pb.authStore.record?.id ?? null;
  const currentNominatorTeamId = getNominatorForPick(
    draftPicks.length,
    draftPicks,
    teams,
    settings.paidAuctionSlots,
  );
  const activeNominationUserId = activePlayer
    ? optimisticPlayer !== undefined
      ? userId
      : latestNomination?.user ?? null
    : null;
  const canNominate = !isReadOnly && !noNominations && (
    !isSharedOfficialAuction ||
    canNominateOfficialPlayer({
      isCommissioner,
      userTeamId,
      currentNominatorTeamId,
      activeNominationUserId,
      userId,
    })
  );
  const canClearActivePlayer = !!activePlayer && !isReadOnly && !noNominations && (
    !isSharedOfficialAuction ||
    canClearOfficialNomination({
      isCommissioner,
      userId,
      activeNominationUserId,
    })
  );

  // Local/mock nomination state must never leak when the selected auction
  // changes. Shared official state will hydrate from that auction's event query.
  useEffect(() => {
    setLocalActivePlayer(null);
    setPendingSharedPlayer(null);
  }, [auctionId]);

  const setActivePlayer = useCallback((player: Player | null) => {
    if (isReadOnly) return;
    if (!selectedAuction || selectedAuction.type !== 'official') {
      setLocalActivePlayer(player);
      return;
    }
    if (player && !canNominate) return;
    if (!player && !canClearActivePlayer) return;

    const requestId = ++requestIdRef.current;
    setPendingSharedPlayer({
      auctionId: selectedAuction.id,
      requestId,
      player,
    });
    createNominationEvent.mutate({
      action: player ? 'nominate' : 'clear',
      playerId: player?.id ?? null,
    }, {
      onSettled: () => {
        setPendingSharedPlayer((pending) =>
          pending?.requestId === requestId ? null : pending
        );
      },
    });
  }, [canClearActivePlayer, canNominate, createNominationEvent, isReadOnly, selectedAuction]);

  return (
    <ActiveDraftContext.Provider value={{
      activePlayer,
      canNominate,
      canClearActivePlayer,
      setActivePlayer,
    }}>
      {children}
    </ActiveDraftContext.Provider>
  );
}

export function useActiveDraft() {
  const context = useContext(ActiveDraftContext);
  if (context === undefined) {
    throw new Error('useActiveDraft must be used within an ActiveDraftProvider');
  }
  return context;
}
