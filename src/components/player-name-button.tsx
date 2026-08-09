'use client';

import type { ButtonHTMLAttributes, MouseEvent, ReactNode } from 'react';
import { usePlayerDetail } from '@/contexts/player-detail-context';
import type { Player } from '@/server/types/player';
import { cn } from '@/lib/utils';

interface PlayerNameButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'onClick'> {
  player: Player;
  children?: ReactNode;
}

export function PlayerNameButton({ player, children, className, ...props }: PlayerNameButtonProps) {
  const { showPlayerDetail } = usePlayerDetail();

  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    showPlayerDetail(player);
  };

  return (
    <button
      type="button"
      className={cn(
        'min-w-0 text-left underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1',
        className,
      )}
      onClick={handleClick}
      aria-label={`View pricing and comps for ${player.name}`}
      {...props}
    >
      {children ?? player.name}
    </button>
  );
}
