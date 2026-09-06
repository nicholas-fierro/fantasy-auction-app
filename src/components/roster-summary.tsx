'use client';

import { Badge } from '@/components/ui/badge';
import { PositionBadge } from '@/components/position-badge';
import { useAllDraftPicks } from '@/hooks/use-draft-picks';
import { useIsSnakeLeague, useLeague, useUserTeamId } from '@/hooks/use-league';
import { buildRosterFromPicks, type RosterSlot } from '@/lib/roster';
import { PlayerNameButton } from '@/components/player-name-button';

export function RosterSummary() {
  const { data: draftPicks = [] } = useAllDraftPicks();
  const userTeamId = useUserTeamId();
  const { settings } = useLeague();

  // Filter picks for user's team
  const userPicks = draftPicks.filter(pick => pick.fantasy_team_id === userTeamId);

  // Build simplified roster from picks
  const rosterData = buildRosterFromPicks(userPicks, settings);

  // Sale price per player, for the roster slot display (null in snake leagues)
  const isSnakeLeague = useIsSnakeLeague();
  const priceByPlayerId = new Map(userPicks.map(pick => [pick.player_id, pick.price]));

  return (
    <div className="space-y-2">
      {/* Starters */}
      <div className="space-y-1">
        {rosterData.starters.map((slot, index) => (
          <RosterSlotDisplay key={`starter-${index}`} slot={slot} price={isSnakeLeague ? null : slot.player ? priceByPlayerId.get(slot.player.id) ?? null : null} />
        ))}
      </div>

      {/* Bench (show all 6 spots) */}
      <div className="pt-2 border-t border-gray-200 dark:border-gray-700">
        <div className="text-xs font-medium text-gray-500 mb-1">BENCH</div>
        <div className="space-y-1">
          {rosterData.bench.map((slot, index) => (
            <RosterSlotDisplay key={`bench-${index}`} slot={slot} price={isSnakeLeague ? null : slot.player ? priceByPlayerId.get(slot.player.id) ?? null : null} />
          ))}
        </div>
      </div>
    </div>
  );
}

function RosterSlotDisplay({ slot, price }: { slot: RosterSlot; price: number | null }) {
  if (!slot.player) {
    return (
      <div className="flex items-center justify-between py-1 text-xs max-md:min-h-11">
        <span className="font-medium text-gray-400">{slot.position}</span>
        <span className="text-gray-300">—</span>
      </div>
    );
  }

  const hasAuctionValue = price !== null && price > 0;
  const isBenchPlayer = slot.position === 'BN';

  return (
    <div className="flex items-center justify-between py-1 text-xs max-md:min-h-11">
      <div className="flex items-center space-x-1 flex-1 min-w-0">
        {isBenchPlayer ? (
          <PositionBadge position={slot.player.position} className="text-xs h-4 px-1" />
        ) : (
          <span className="font-medium text-gray-600 dark:text-gray-400 w-6 text-xs">
            {slot.position}
          </span>
        )}
        <PlayerNameButton player={slot.player} className="truncate ps-2 font-medium max-md:leading-[2.75rem]" />
        {hasAuctionValue && (
          <Badge variant="secondary" className="text-xs ps-1 h-4">
            ${price}
          </Badge>
        )}
      </div>
      <div className="text-xs text-gray-400 ml-1 max-md:shrink-0 max-md:whitespace-nowrap">
        {slot.player.team} • {slot.player.bye_week}
      </div>
    </div>
  );
}
