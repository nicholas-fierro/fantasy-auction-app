'use client';

import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Star, LayoutGrid, List } from 'lucide-react';
import { FantasyTeam } from '@/server/types/fantasy-team';
import { DraftPickWithDetails } from '@/server/types/draft-pick';
import { cn } from '@/lib/utils';
import { PlayerNameButton } from '@/components/player-name-button';
import {
  buildRosterFromPicks,
  type RosterSlot,
} from '@/lib/roster';
import { useIsSnakeLeague, useLeague, useUserTeamId } from '@/hooks/use-league';

export type RosterViewMode = 'flat' | 'slots';

interface TeamRosterCardProps {
  team: FantasyTeam;
  draftPicks: DraftPickWithDetails[];
  /** Which roster layout to render. Controlled by the parent so one toggle drives the whole grid. */
  view: RosterViewMode;
  /** Override the subtitle text shown in flat mode. If omitted, "{n} picks · Top pick ${top}" is used. */
  subtitleOverride?: string;
}

/** Shared segmented control for switching a roster card grid between flat and starters/bench views. */
export function RosterViewToggle({
  view,
  onChange,
}: {
  view: RosterViewMode;
  onChange: (view: RosterViewMode) => void;
}) {
  return (
    <div className="inline-flex gap-1 rounded-[10px] bg-gray-200 p-1 dark:bg-gray-800">
      <Button
        size="sm"
        variant={view === 'slots' ? 'outline' : 'ghost'}
        className="h-8 max-md:h-10 max-md:px-2"
        onClick={() => onChange('slots')}
        aria-label="Lineup view"
      >
        <LayoutGrid className="h-4 w-4" />
        <span className="max-md:hidden">Lineup</span>
      </Button>
      <Button
        size="sm"
        variant={view === 'flat' ? 'outline' : 'ghost'}
        className="h-8 max-md:h-10 max-md:px-2"
        onClick={() => onChange('flat')}
        aria-label="Flat view"
      >
        <List className="h-4 w-4" />
        <span className="max-md:hidden">Flat</span>
      </Button>
    </div>
  );
}

const positionStyles: Record<string, string> = {
  QB: 'bg-yellow-100 text-yellow-800',
  RB: 'bg-green-100 text-green-800',
  WR: 'bg-purple-100 text-purple-800',
  TE: 'bg-red-100 text-red-800',
  K: 'bg-blue-100 text-blue-800',
  DST: 'bg-orange-100 text-orange-800',
};

export function PositionLabel({ position }: { position: string }) {
  return (
    <span className={`shrink-0 rounded px-1.5 py-0.5 text-[9px] font-bold ${positionStyles[position] ?? 'bg-gray-100 text-gray-700'}`}>
      {position}
    </span>
  );
}

export function TeamRosterCard({
  team,
  draftPicks,
  view,
  subtitleOverride,
}: TeamRosterCardProps) {
  const userTeamId = useUserTeamId();
  const { settings } = useLeague();
  const isSnakeLeague = useIsSnakeLeague();

  const isUserTeam = team.id === userTeamId;
  const rosterData = buildRosterFromPicks(draftPicks, settings);

  const priceByPlayerId = new Map(draftPicks.map(pick => [pick.player_id, pick.price]));

  const sortedByPrice = [...draftPicks].sort((a, b) => (b.price ?? 0) - (a.price ?? 0));
  const top = sortedByPrice[0]?.price ?? 0;

  // Flat view: every roster slot rendered — filled slots (by price desc) first,
  // then the team's remaining empty slots so the card never collapses.
  const allSlots = [...rosterData.starters, ...rosterData.bench];
  const filledSlots = allSlots
    .filter(slot => slot.player !== null)
    .sort((a, b) => (priceByPlayerId.get(b.player!.id) ?? 0) - (priceByPlayerId.get(a.player!.id) ?? 0));
  const emptySlots = allSlots.filter(slot => slot.player === null);

  const subtitle = subtitleOverride ?? (isSnakeLeague
    ? `${draftPicks.length} picks`
    : `${draftPicks.length} picks · Top pick $${top}`);

  return (
    <Card className={cn(
      "w-full gap-0 rounded-[13px] py-0 shadow-sm",
      isUserTeam && "ring-2 ring-yellow-400 ring-offset-2"
    )}>
      <CardHeader className="gap-1 px-3 pt-3 pb-0">
        <div className="flex items-center justify-between">
          <div className="min-w-0 flex items-center space-x-2">
            <span className="flex h-[22px] w-[22px] items-center justify-center rounded-md bg-gray-100 text-[10px] font-bold text-gray-600 dark:bg-gray-800 dark:text-gray-300">
              {team.draft_order}
            </span>
            <div className="flex min-w-0 items-center space-x-1">
              <h3 className="truncate text-[14.5px] font-bold text-gray-900 dark:text-white">{team.name}</h3>
              {isUserTeam && (
                <Star className="h-3.5 w-3.5 shrink-0 fill-yellow-400 text-yellow-400" />
              )}
            </div>
          </div>
        </div>
        <div className="mb-1 flex items-center justify-between text-[11px] text-gray-400">
          <span>{subtitle}</span>
        </div>
      </CardHeader>
      <CardContent className="p-4 pt-0">
        {view === 'flat' ? (
          <div className="space-y-1">
            {filledSlots.map((slot, index) => (
              <RosterSlotRow
                key={`filled-${slot.player!.id}-${index}`}
                slot={slot}
                price={priceByPlayerId.get(slot.player!.id) ?? null}
              />
            ))}
            {emptySlots.map((slot, index) => (
              <RosterSlotRow key={`empty-${slot.position}-${index}`} slot={slot} price={null} />
            ))}
          </div>
        ) : (
          <div className="space-y-2">
            <div>
              <h4 className="mb-1 text-[11px] font-semibold text-gray-600">STARTERS</h4>
              <div className="space-y-1">
                {rosterData.starters.map((slot, index) => (
                  <RosterSlotRow
                    key={`starter-${index}`}
                    slot={slot}
                    price={slot.player ? priceByPlayerId.get(slot.player.id) ?? null : null}
                  />
                ))}
              </div>
            </div>
            <div>
              <h4 className="mb-1 text-[11px] font-semibold text-gray-600">BENCH</h4>
              <div className="space-y-1">
                {rosterData.bench.map((slot, index) => (
                  <RosterSlotRow
                    key={`bench-${index}`}
                    slot={slot}
                    price={slot.player ? priceByPlayerId.get(slot.player.id) ?? null : null}
                  />
                ))}
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function RosterSlotRow({ slot, price }: { slot: RosterSlot; price: number | null }) {
  const isBenchPlayer = slot.position === 'BN';
  // Price column hidden in snake leagues — hook call lives here (not in the
  // parent) because both the flat and slots layouts render through this row.
  const hidePrice = useIsSnakeLeague();

  if (!slot.player) {
    return (
      <div className="flex items-center gap-2 py-0.5 max-md:min-h-11">
        <PositionLabel position={slot.position} />
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-gray-400">—</span>
        <span className="text-[10px] text-gray-400">&nbsp;</span>
        {!hidePrice && (
          <span className="w-9 shrink-0 text-right text-xs font-bold tabular-nums text-gray-400">—</span>
        )}
      </div>
    );
  }

  const displayPosition = isBenchPlayer ? slot.player.position : slot.position;

  return (
    <div className="flex items-center gap-2 py-0.5 max-md:min-h-11">
      <PositionLabel position={displayPosition} />
      {/* Line-height gives the tap target its 44px on touch without a taller row. */}
      <PlayerNameButton player={slot.player} className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-gray-800 max-md:leading-[2.75rem] dark:text-gray-200" />
      <span className="text-[10px] text-gray-400">{slot.player.team} · {slot.player.bye_week}</span>
      {!hidePrice && (
        <span className="w-9 shrink-0 text-right text-xs font-bold tabular-nums text-gray-700 dark:text-gray-300">
          {price == null || price <= 0 ? '—' : `$${price}`}
        </span>
      )}
    </div>
  );
}
