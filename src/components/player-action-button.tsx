'use client';

import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Receipt, UserPlus } from 'lucide-react';
import { useActiveDraft } from '@/contexts/active-draft-context';
import { useIsSnakeLeague } from '@/hooks/use-league';
import { useAuction } from '@/contexts/auction-context';
import { useMockDraft } from '@/contexts/mock-draft-context';
import { Player } from '@/server/types/player';
import { cn } from '@/lib/utils';

interface PlayerActionButtonProps {
  player: Player;
  isDrafted: boolean;
  isPlayerDrafting: boolean;
  canSnakeDraft: boolean;
  canNominate: boolean;
  onAction: (player: Player) => void;
  size?: 'sm' | 'default';
  showLabel?: boolean;
  hideWhenActive?: boolean;
  className?: string;
}

export function PlayerActionButton({
  player,
  isDrafted,
  isPlayerDrafting,
  canSnakeDraft,
  canNominate,
  onAction,
  size = 'sm',
  showLabel = false,
  hideWhenActive = false,
  className
}: PlayerActionButtonProps) {
  const { activePlayer } = useActiveDraft();
  const isSnakeDraft = useIsSnakeLeague();
  const { isReadOnly } = useAuction();
  const mockDraft = useMockDraft();

  const isActive = activePlayer?.id === player.id;

  if (isDrafted || isReadOnly) return null;

  // The sim has its own turn state — derive the row action from it instead of
  // the real-auction canNominate/canSnakeDraft lanes (auto draft mode doesn't
  // know the sim's phase).
  if (mockDraft.isActive) {
    const canAct = mockDraft.status === 'user-nominate' || mockDraft.status === 'snake-user';
    return (
      <Button
        size={size}
        variant="outline"
        onClick={() => onAction(player)}
        disabled={!canAct}
        title={!canAct ? 'Wait for your turn' : undefined}
        className={cn("transition-none hover:cursor-pointer", className)}
      >
        {mockDraft.phase === 'snake' ?
          <UserPlus className="h-3 w-3" />
          :
          <Receipt className="h-3 w-3" />
        }
        {showLabel && (mockDraft.phase === 'snake' ? 'Draft' : 'Nominate')}
      </Button>
    );
  }

  if (isActive && !isSnakeDraft) {
    if (hideWhenActive) return null;
    return (
      <Button
        size={size}
        variant="outline"
        disabled
        title="Player is active"
        className={cn(
          "border-blue-200 bg-blue-100 text-blue-800 opacity-100 dark:border-blue-800 dark:bg-blue-900/50 dark:text-blue-400",
          className
        )}
      >
        <Receipt className="h-3 w-3" />
        {showLabel && 'Nominated'}
      </Button>
    );
  }

  if (isPlayerDrafting) {
    return (
      <Badge variant="secondary" className={cn("bg-green-100 text-green-800 dark:bg-green-900/50 dark:text-green-400", className)}>
        {showLabel ? 'Drafting…' : '...'}
      </Badge>
    );
  }

  return (
    <Button
      size={size}
      variant="outline"
      onClick={() => onAction(player)}
      disabled={isSnakeDraft ? !canSnakeDraft : !canNominate}
      title={
        isSnakeDraft && !canSnakeDraft
          ? 'Wait for your draft turn'
          : !isSnakeDraft && !canNominate
            ? 'Wait for your nomination turn'
            : undefined
      }
      className={cn("transition-none hover:cursor-pointer", className)}
    >
      {isSnakeDraft ?
        <UserPlus className="h-3 w-3" />
        :
        <Receipt className="h-3 w-3" />
      }
      {showLabel && (isSnakeDraft ? 'Draft' : 'Nominate')}
    </Button>
  );
}
