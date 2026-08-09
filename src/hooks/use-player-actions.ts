import { useCallback, useState } from 'react';
import { useCreateDraftPick, useAllDraftPicks } from '@/hooks/use-draft-picks';
import { useAuctionTeams } from '@/hooks/use-fantasy-teams';
import { useDraftRole, useLeague } from '@/hooks/use-league';
import { useActiveDraft } from '@/contexts/active-draft-context';
import { useNavigation } from '@/contexts/navigation-context';
import { useAuction } from '@/contexts/auction-context';
import { useMockDraft } from '@/contexts/mock-draft-context';
import { calculateCurrentSnakeTeam } from '@/lib/snake-draft';
import { Player } from '@/server/types/player';

export interface PlayerActionState {
  isDraftingPlayer: string | null;
  isPlayerDrafting: (playerId: string) => boolean;
  canSnakeDraft: boolean;
  canNominate: boolean;
  currentSnakeTeam: ReturnType<typeof calculateCurrentSnakeTeam>['currentTeam'];
  isReadOnly: boolean;
}

export interface PlayerActionHandlers {
  handlePlayerAction: (player: Player) => void;
  handleSnakeDraft: (player: Player) => Promise<void>;
  handleMakeActive: (player: Player) => void;
}

export function usePlayerActions(): PlayerActionState & PlayerActionHandlers {
  const [isDraftingPlayer, setIsDraftingPlayer] = useState<string | null>(null);

  const { canNominate, setActivePlayer } = useActiveDraft();
  const { isSnakeMode } = useNavigation();
  const { isReadOnly } = useAuction();
  const mockDraft = useMockDraft();
  const { data: teams = [] } = useAuctionTeams();
  const { data: draftPicks = [] } = useAllDraftPicks();
  const { mutateAsync } = useCreateDraftPick();
  const { canPickAnyTeam, userTeamId } = useDraftRole();
  const { settings } = useLeague();

  // Calculate snake draft team queue
  const snakeTeamQueue = calculateCurrentSnakeTeam(
    teams,
    draftPicks.length,
    settings.paidAuctionSlots,
  );

  // Admin lane drafts for whichever team is on the clock; a member only when
  // the team on the clock is their own.
  const canActForCurrentTeam =
    !!snakeTeamQueue.currentTeam &&
    (canPickAnyTeam || snakeTeamQueue.currentTeam.id === userTeamId);

  const handleSnakeDraft = useCallback(async (player: Player) => {
    if (isReadOnly || !isSnakeMode || !snakeTeamQueue.currentTeam || !canActForCurrentTeam) return;

    if (mockDraft.isActive) {
      if (mockDraft.status === 'snake-user') mockDraft.submitSnakePick(player);
      return;
    }

    setIsDraftingPlayer(player.id);
    try {
      // pick_order is assigned server-side (pb_hooks/draft_picks_pick_order.pb.js)
      await mutateAsync({
        fantasy_team_id: snakeTeamQueue.currentTeam.id,
        player_id: player.id,
      });
    } catch (error) {
      console.error('Failed to draft player in snake mode:', error);
    } finally {
      setIsDraftingPlayer(null);
    }
  }, [isReadOnly, isSnakeMode, snakeTeamQueue.currentTeam, canActForCurrentTeam, mockDraft, mutateAsync]);

  const handleMakeActive = useCallback((player: Player) => {
    if (isReadOnly || !canNominate) return;
    if (mockDraft.isActive && mockDraft.status !== 'user-nominate') return;
    setActivePlayer(player);
  }, [canNominate, isReadOnly, mockDraft.isActive, mockDraft.status, setActivePlayer]);

  const handlePlayerAction = useCallback((player: Player) => {
    if (isReadOnly) return;
    if (mockDraft.isActive) {
      if (isSnakeMode) {
        void handleSnakeDraft(player);
      } else if (mockDraft.status === 'user-nominate') {
        mockDraft.nominate(player);
      }
      return;
    }
    if (isSnakeMode) {
      void handleSnakeDraft(player);
    } else {
      if (!canNominate) return;
      setActivePlayer(player);
    }
  }, [canNominate, isReadOnly, mockDraft, isSnakeMode, handleSnakeDraft, setActivePlayer]);

  return {
    // State
    isDraftingPlayer,
    isPlayerDrafting: (playerId: string) => isDraftingPlayer === playerId,
    canSnakeDraft:
      isSnakeMode &&
      !isReadOnly &&
      canActForCurrentTeam &&
      (!mockDraft.isActive || mockDraft.status === 'snake-user'),
    canNominate,
    currentSnakeTeam: snakeTeamQueue.currentTeam,
    isReadOnly,

    // Handlers
    handlePlayerAction,
    handleSnakeDraft,
    handleMakeActive,
  };
}
