'use client';

import { Button } from '@/components/ui/button';
import { Star, StarOff } from 'lucide-react';
import { cn } from '@/lib/utils';

interface WatchlistButtonProps {
  isWatched: boolean;
  onToggle: () => void;
  size?: 'sm' | 'default';
  className?: string;
}

export function WatchlistButton({ isWatched, onToggle, size = 'sm', className }: WatchlistButtonProps) {
  return (
    <Button
      size={size}
      variant="outline"
      onClick={onToggle}
      className={cn(className, "hover:cursor-pointer")}
      title={isWatched ? 'Remove from watchlist' : 'Add to watchlist'}
    >
      {isWatched ? (
        <Star className="h-3 w-3 fill-yellow-400 text-yellow-400" />
      ) : (
        <StarOff className="h-3 w-3" />
      )}
    </Button>
  );
}
