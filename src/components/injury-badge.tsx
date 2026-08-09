'use client';

import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { PlayerInjury } from '@/lib/sleeper-injuries';
import { cn } from '@/lib/utils';

interface InjuryBadgeProps {
  injury: PlayerInjury;
  compact?: boolean;
  className?: string;
}

const SEVERITY_CLASSES: Record<PlayerInjury['severity'], string> = {
  critical: 'border-red-700 bg-red-600 text-white dark:border-red-500 dark:bg-red-700',
  warning: 'border-orange-700 bg-orange-500 text-white dark:border-orange-500 dark:bg-orange-700',
  caution: 'border-amber-600 bg-amber-400 text-amber-950 dark:border-amber-400 dark:bg-amber-500 dark:text-amber-950',
};

export function getInjuryDescription(injury: PlayerInjury): string {
  return [injury.status, injury.bodyPart, injury.practiceParticipation]
    .filter(Boolean)
    .join(' · ');
}

export function InjuryBadge({ injury, compact = false, className }: InjuryBadgeProps) {
  const description = getInjuryDescription(injury);

  const badge = (
    <Badge
      className={cn(
        SEVERITY_CLASSES[injury.severity],
        compact && 'h-4 min-w-4 rounded-full px-1 text-[9px] leading-none',
        className
      )}
      aria-label={`Injury status: ${description}`}
    >
      {compact ? injury.shortStatus : injury.status}
    </Badge>
  );

  if (!compact) return badge;

  return (
    <Tooltip>
      <TooltipTrigger asChild>{badge}</TooltipTrigger>
      <TooltipContent>{description}</TooltipContent>
    </Tooltip>
  );
}
