'use client';

import { memo } from 'react';
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar';
import { getPositionBadgeClasses, type FilterPosition } from '@/lib/position-colors';
import { getPlayerImageUrl } from '@/lib/player-images';
import { cn } from '@/lib/utils';

interface PlayerAvatarProps {
  name: string;
  position: string;
  team?: string | null;
  sleeperId?: string | null;
  espnId?: string | null;
  size?: number;
  className?: string;
}

function getInitials(name: string, position: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return position ? position.slice(0, 2).toUpperCase() : '?';
  }
  const initials = words.slice(0, 2).map(word => word[0]).join('');
  return initials.toUpperCase();
}

function getFallbackTextSizeClass(size: number): string {
  if (size <= 24) return 'text-[10px]';
  if (size <= 40) return 'text-xs';
  return 'text-sm';
}

export const PlayerAvatar = memo(function PlayerAvatar({
  name,
  position,
  team,
  sleeperId,
  espnId,
  size = 32,
  className,
}: PlayerAvatarProps) {
  const src = getPlayerImageUrl({ position, team, sleeperId, espnId }, size);
  const initials = getInitials(name, position);

  return (
    <Avatar
      className={cn('shrink-0', className)}
      style={{ width: size, height: size }}
    >
      {src && (
        <AvatarImage
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          width={size}
          height={size}
          className="object-cover object-top"
          draggable={false}
        />
      )}
      <AvatarFallback
        delayMs={src ? 150 : 0}
        className={cn(getPositionBadgeClasses(position as FilterPosition), getFallbackTextSizeClass(size), 'font-semibold')}
      >
        {initials}
      </AvatarFallback>
    </Avatar>
  );
});
