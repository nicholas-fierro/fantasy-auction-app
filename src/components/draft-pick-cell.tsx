'use client';

import { DraftPickWithDetails } from '@/server/types/draft-pick';
import { getPositionBackgroundClasses, type FilterPosition } from '@/lib/position-colors';
import { cn } from '@/lib/utils';
import { PlayerNameButton } from '@/components/player-name-button';

interface DraftPickCellProps {
  draftPick?: DraftPickWithDetails;
  className?: string;
}

export function DraftPickCell({ draftPick, className }: DraftPickCellProps) {
  if (!draftPick) {
    return (
      <div className={cn(
        "h-[46px] rounded-md border border-[#efedeb] bg-white dark:border-gray-700 dark:bg-gray-800/50",
        className
      )} />
    );
  }

  const { player } = draftPick;
  const auctionValue = draftPick.price;
  const nameParts = player.name.trim().split(/\s+/);
  const hasFirstName = nameParts.length > 1;
  const firstName = hasFirstName ? nameParts[0] : '';
  const lastName = hasFirstName ? nameParts.slice(1).join(' ') : player.name;

  const positionBg = getPositionBackgroundClasses(player.position as FilterPosition);

  return (
    <div className={cn(
      "flex h-[46px] min-w-0 flex-col justify-center rounded-md border border-[#efedeb] px-[7px] py-[3px] transition-shadow hover:shadow-md dark:border-gray-700",
      positionBg,
      className
    )}>
      <div className="flex min-w-0 items-start gap-1">
        <div className="min-w-0 flex-1">
          {hasFirstName && (
            <div className="truncate text-[9px] leading-[1.25] text-stone-500 dark:text-gray-400">
              {firstName}
            </div>
          )}
          <PlayerNameButton
            player={player}
            className="line-clamp-2 w-full [overflow-wrap:anywhere] text-[11px] font-semibold leading-[1.12] tracking-[-0.01em] text-stone-900 dark:text-white"
          >
            {lastName}
          </PlayerNameButton>
        </div>
        {auctionValue != null && (
          <span className="shrink-0 text-[10px] font-semibold text-green-800 dark:text-green-400">
            ${auctionValue}
          </span>
        )}
      </div>
      <div className="mt-px truncate text-[8.5px] leading-[1.3] text-stone-400 dark:text-gray-400">
        {player.team} · {player.position} · Bye {player.bye_week}
      </div>
    </div>
  );
}
