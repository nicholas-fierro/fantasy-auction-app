import { AlertTriangle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { PositionBadge } from '@/components/position-badge';
import { getTierCliffAlerts } from '@/lib/draft-insights';
import type { DraftPickWithDetails } from '@/server/types/draft-pick';
import type { Player } from '@/server/types/player';

export function TierCliffAlerts({
  players,
  draftPicks,
}: {
  players: readonly Player[];
  draftPicks: readonly DraftPickWithDetails[];
}) {
  const alerts = getTierCliffAlerts(players, draftPicks);
  if (alerts.length === 0) return null;

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 dark:border-amber-900/70 dark:bg-amber-950/30">
      <div className="flex items-center gap-1.5 text-xs font-semibold text-amber-800 dark:text-amber-300">
        <AlertTriangle className="h-3.5 w-3.5" />
        Tier cliffs
      </div>
      {alerts.map(alert => (
        <Badge
          key={`${alert.position}-${alert.tier}`}
          variant="outline"
          className="gap-1 border-amber-300 bg-white text-xs dark:border-amber-800 dark:bg-gray-900"
        >
          <PositionBadge position={alert.position} className="px-1 py-0 text-[10px]" />
          Tier {alert.tier}: {alert.remaining} left
        </Badge>
      ))}
    </div>
  );
}
