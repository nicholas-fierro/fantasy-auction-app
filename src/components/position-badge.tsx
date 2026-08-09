'use client';

import { Badge } from '@/components/ui/badge';
import { getPositionBadgeClasses, type FilterPosition } from '@/lib/position-colors';
import { cn } from '@/lib/utils';

interface PositionBadgeProps {
  position: string;
  className?: string;
}

export function PositionBadge({ position, className }: PositionBadgeProps) {
  const colorClass = getPositionBadgeClasses(position as FilterPosition);

  return (
    <Badge
      variant="outline"
      className={cn(colorClass, 'font-semibold', className)}
    >
      {position}
    </Badge>
  );
}