'use client';

import { useMemo } from 'react';
import { ChevronDown, Gauge } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import {
  buildRosterFromPicks,
  calculateBudgetSummary,
} from '@/lib/roster';
import { useLeague, useUserTeamId } from '@/hooks/use-league';
import { useIsMobile } from '@/hooks/use-is-mobile';
import { getPositionBadgeClasses, type FilterPosition } from '@/lib/position-colors';
import { cn } from '@/lib/utils';
import type { DraftPickWithDetails } from '@/server/types/draft-pick';
import type { FantasyTeam } from '@/server/types/fantasy-team';

interface NeedChip {
  label: string;
  position: string;
}

function collapseNeeds(positions: string[]): NeedChip[] {
  const order: string[] = [];
  const counts = new Map<string, number>();
  for (const position of positions) {
    if (!counts.has(position)) order.push(position);
    counts.set(position, (counts.get(position) ?? 0) + 1);
  }
  return order.map(position => {
    const count = counts.get(position) ?? 0;
    return {
      position,
      label: count > 1 ? `${position}×${count}` : position,
    };
  });
}

/** FLEX (roster slot key) needs to map to 'Flex' (position-colors key) for chip coloring. */
function toChipPosition(position: string): FilterPosition {
  return position === 'FLEX' ? 'Flex' : (position as FilterPosition);
}

export function TeamBudgetPressure({
  teams,
  draftPicks,
}: {
  teams: readonly FantasyTeam[];
  draftPicks: readonly DraftPickWithDetails[];
}) {
  const userTeamId = useUserTeamId();
  const { settings } = useLeague();
  const isMobile = useIsMobile();

  const rows = useMemo(() => {
    const budgetLimit = settings.budget;

    const firstPass = [...teams]
      .sort((a, b) => a.draft_order - b.draft_order)
      .map(team => {
        const teamPicks = draftPicks.filter(pick => pick.fantasy_team_id === team.id);
        const budget = calculateBudgetSummary(teamPicks, settings);
        const roster = buildRosterFromPicks(teamPicks, settings);
        const needs = roster.starters.filter(slot => !slot.player).map(slot => slot.position);
        const skillNeeds = needs.filter(position => position !== 'K' && position !== 'DST').length;
        const avgPerSlot = budget.remainingAuctionPicks > 0
          ? Math.floor(budget.remainingBudget / budget.remainingAuctionPicks)
          : 0;
        const isMe = team.id === userTeamId;
        return { team, budget, needs, skillNeeds, avgPerSlot, isMe };
      });

    const myMax = firstPass.find(row => row.isMe)?.budget.maxBid ?? 0;

    return firstPass.map(row => {
      const out = row.budget.remainingBudget <= 0 || row.budget.remainingAuctionPicks <= 0;
      const canOutbid = !row.isMe && row.budget.maxBid > myMax;
      const stuck = !row.isMe && row.skillNeeds >= 3 && row.avgPerSlot <= 15;
      const spentPct = budgetLimit > 0 ? (row.budget.totalSpent / budgetLimit) * 100 : 0;
      const chips = collapseNeeds(row.needs);
      return { ...row, out, canOutbid, stuck, spentPct, chips };
    });
  }, [teams, draftPicks, userTeamId, settings]);

  return (
    <details open={!isMobile} className="group mb-3 rounded-lg border bg-white dark:bg-gray-950">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-sm font-semibold max-md:min-h-11 max-md:flex-wrap">
        <Gauge className="h-4 w-4" />
        Team budget pressure
        <span className="text-xs font-normal text-muted-foreground">max bids and roster needs</span>
        <span className="hidden items-center gap-3 text-xs font-normal text-muted-foreground sm:ml-auto sm:flex">
          <span className="flex items-center gap-1">
            <span className="h-2 w-2 rounded-full bg-red-600" />
            Can outbid you
          </span>
          <span className="flex items-center gap-1">
            <span className="h-2 w-2 rounded-full bg-amber-500" />
            Stuck
          </span>
          <span className="flex items-center gap-1">
            <span className="h-2 w-2 rounded-full bg-green-600" />
            Out
          </span>
        </span>
        <ChevronDown className="ml-auto h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180 sm:ml-0" />
      </summary>
      <div className="grid grid-cols-1 gap-px overflow-hidden border-t bg-border sm:grid-cols-3 lg:grid-cols-6">
        {rows.map(({ team, budget, avgPerSlot, isMe, out, canOutbid, stuck, spentPct, chips }) => (
          <div
            key={team.id}
            className={cn(
              'relative bg-white p-3 dark:bg-gray-950',
              isMe && 'bg-muted/40',
            )}
          >
            <span
              className={cn(
                'absolute inset-x-0 top-0 h-[3px]',
                out ? 'bg-green-600' : canOutbid ? 'bg-red-600' : stuck ? 'bg-amber-500' : 'bg-transparent',
              )}
            />
            <div className="flex items-center gap-1.5 text-xs font-medium">
              <span className="truncate">{team.name}</span>
              {isMe && <Badge className="px-1 py-0 text-[9px]">You</Badge>}
              <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
                #{team.draft_order}
              </span>
            </div>

            <div className="mt-1 flex items-baseline gap-1">
              <span
                className={cn(
                  'text-2xl font-semibold tabular-nums',
                  out
                    ? 'text-green-600 dark:text-green-500'
                    : canOutbid
                      ? 'text-red-600'
                      : stuck
                        ? 'text-amber-600 dark:text-amber-500'
                        : 'text-foreground',
                )}
              >
                ${budget.maxBid}
              </span>
              <span className="text-[10px] text-muted-foreground">max bid</span>
            </div>

            <div className="mt-0.5 text-[11px] tabular-nums text-muted-foreground">
              ${budget.remainingBudget} left · ${avgPerSlot}/slot
            </div>

            <div className="mt-2 h-1.5 w-full rounded bg-muted">
              <div
                className="h-1.5 rounded bg-gray-300 dark:bg-gray-600"
                style={{ width: `${Math.min(100, Math.max(0, spentPct))}%` }}
              />
            </div>

            <div className="mt-1 flex justify-between text-[11px] tabular-nums text-muted-foreground">
              <span>${budget.totalSpent} spent</span>
              <span>{budget.remainingAuctionPicks} slot{budget.remainingAuctionPicks === 1 ? '' : 's'} left</span>
            </div>

            <div className="mt-2 flex min-h-5 flex-wrap gap-1">
              {chips.length > 0
                ? chips.map(chip => (
                  <span
                    key={chip.position}
                    className={cn(
                      'rounded border px-1 py-0.5 text-[9px] leading-none',
                      getPositionBadgeClasses(toChipPosition(chip.position)),
                    )}
                  >
                    {chip.label}
                  </span>
                ))
                : <span className="text-[10px] text-muted-foreground">Starters filled</span>}
            </div>
          </div>
        ))}
      </div>
    </details>
  );
}
