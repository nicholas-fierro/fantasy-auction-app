'use client';

import { Badge } from '@/components/ui/badge';
import { getPositionBadgeClasses, getPositionSelectedBadgeClasses, type FilterPosition } from '@/lib/position-colors';
import { cn } from '@/lib/utils';

interface PositionFilterProps {
  selectedPositions: Set<FilterPosition>;
  onPositionToggle: (position: FilterPosition) => void;
  className?: string;
}

const positions: FilterPosition[] = ['QB', 'RB', 'WR', 'TE', 'Flex', 'K', 'DST'];

export function PositionFilter({ selectedPositions, onPositionToggle, className }: PositionFilterProps) {
  return (
    <div className={cn("flex items-center gap-3 flex-wrap", className)}>
      <div className="flex items-center gap-2 flex-wrap">
        {positions.map((position) => {
          const isSelected = selectedPositions.has(position);
          const colorClass = isSelected
            ? getPositionSelectedBadgeClasses(position)
            : getPositionBadgeClasses(position);

          return (
            <Badge
              key={position}
              variant="outline"
              className={cn(
                colorClass,
                'font-semibold cursor-pointer hover:opacity-80 transition-opacity select-none',
                'transition-none', // Remove slow transitions
                'max-md:min-h-11 max-md:px-4 max-md:text-sm' // touch target
              )}
              onClick={() => onPositionToggle(position)}
            >
              {position}
            </Badge>
          );
        })}
      </div>
    </div>
  );
}