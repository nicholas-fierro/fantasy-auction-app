import type { DraftPickWithDetails } from '@/server/types/draft-pick';
import type { Player } from '@/server/types/player';

const INSIGHT_POSITIONS = ['QB', 'RB', 'WR', 'TE', 'K', 'DST'] as const;

export interface TierCliffAlert {
  position: string;
  tier: number;
  remaining: number;
}

export function getTierCliffAlerts(
  players: readonly Player[],
  draftPicks: readonly DraftPickWithDetails[],
  threshold = 2
): TierCliffAlert[] {
  const draftedIds = new Set(draftPicks.map(pick => pick.player_id));

  return INSIGHT_POSITIONS.flatMap(position => {
    const available = players.filter(player =>
      player.position === position &&
      player.tier > 0 &&
      !draftedIds.has(player.id)
    );
    if (available.length === 0) return [];

    const currentTier = Math.min(...available.map(player => player.tier));
    const remaining = available.filter(player => player.tier === currentTier).length;
    const originalTierSize = players.filter(player =>
      player.position === position && player.tier === currentTier
    ).length;
    const hasDraftedPlayer = remaining < originalTierSize;

    return remaining <= threshold && hasDraftedPlayer
      ? [{ position, tier: currentTier, remaining }]
      : [];
  });
}
