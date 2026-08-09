'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { RosterSummary } from '@/components/roster-summary';
import { useAllDraftPicks } from '@/hooks/use-draft-picks';
import { WatchlistItems } from '@/components/watchlist-items';
import { PositionFilter } from '@/components/position-filter';
import { X, Eye, EyeOff, ChevronUp, ChevronDown } from 'lucide-react';
import { useNavigation } from '@/contexts/navigation-context';
import { type FilterPosition } from '@/contexts/navigation-context';
import { calculateBudgetSummary } from '@/lib/roster';
import { useLeague, useUserTeamId } from '@/hooks/use-league';
import { cn } from '@/lib/utils';

export type WatchlistFilter = 'all' | 'available' | 'drafted';

interface WatchlistSidebarProps {
  className?: string;
  /** Overrides the default close behaviour when hosted in a drawer. */
  onClose?: () => void;
}

export function WatchlistSidebar({ className, onClose }: WatchlistSidebarProps) {
  const { setShowWatchlist } = useNavigation();
  const close = onClose ?? (() => setShowWatchlist(false));
  const [filter, setFilter] = useState<WatchlistFilter>('all');
  const [selectedPositions, setSelectedPositions] = useState<Set<FilterPosition>>(new Set());
  const [isRosterMinimized, setIsRosterMinimized] = useState(true);
  const { data: draftPicks = [] } = useAllDraftPicks();
  const userTeamId = useUserTeamId();
  const { settings } = useLeague();

  // Calculate budget info for user's team
  const userPicks = draftPicks.filter(pick => pick.fantasy_team_id === userTeamId);
  const { remainingBudget, remainingAuctionPicks, maxBid } = calculateBudgetSummary(userPicks, settings);

  const handlePositionToggle = (position: FilterPosition) => {
    const newSelected = new Set(selectedPositions);
    if (newSelected.has(position)) {
      newSelected.delete(position);
    } else {
      newSelected.add(position);
    }
    setSelectedPositions(newSelected);
  };

  return (
    <div
      className={cn(
        'w-80 bg-white dark:bg-gray-800 border-l border-gray-200 dark:border-gray-700 flex flex-col overflow-hidden',
        className
      )}
    >
      {/* Header */}
      <div className="p-4 border-b border-gray-200 dark:border-gray-700">
        <div className="flex items-center justify-between m">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
            Quick View
          </h2>
          <Button
            variant="ghost"
            size="sm"
            onClick={close}
            aria-label="Close"
            className="h-11 w-11 p-0 md:h-8 md:w-8"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Content - Scrollable Watchlist */}
      <div className="flex-1 overflow-hidden flex flex-col">
        {/* Watchlist - Scrollable */}
        <div className="flex-1 overflow-auto p-4">
          <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">
            WATCHLIST
          </h3>
          {/* Filter Toggle */}
          <div className="flex items-center space-x-2 pb-4">
            <Label htmlFor="watchlist-filter" className="text-sm font-medium">
              Show:
            </Label>
            <div className="flex items-center space-x-1">
              <Button
                variant={filter === 'all' ? 'default' : 'ghost'}
                size="sm"
                onClick={() => setFilter('all')}
                className="h-9 px-2.5 text-xs md:h-7 md:px-2"
              >
                All
              </Button>
              <Button
                variant={filter === 'available' ? 'default' : 'ghost'}
                size="sm"
                onClick={() => setFilter('available')}
                className="h-9 px-2.5 text-xs md:h-7 md:px-2"
              >
                <Eye className="h-3 w-3 mr-1" />
                Available
              </Button>
              <Button
                variant={filter === 'drafted' ? 'default' : 'ghost'}
                size="sm"
                onClick={() => setFilter('drafted')}
                className="h-9 px-2.5 text-xs md:h-7 md:px-2"
              >
                <EyeOff className="h-3 w-3 mr-1" />
                Drafted
              </Button>
            </div>
          </div>

          {/* Position Filter */}
          <div className="mb-4">
            <PositionFilter
              selectedPositions={selectedPositions}
              onPositionToggle={handlePositionToggle}
              className="text-xs"
            />
          </div>

          <WatchlistItems filter={filter} selectedPositions={selectedPositions} />
        </div>

        {/* My Roster Summary - Sticky at bottom */}
        <div className="max-md:hidden border-t border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
          <div className="flex items-center p-4 pb-2">
            <div className="flex items-center space-x-2">
              <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">
                MY ROSTER
              </h3>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setIsRosterMinimized(!isRosterMinimized)}
                className="h-9 w-9 p-0 md:h-6 md:w-6"
              >
                {isRosterMinimized ? (
                  <ChevronUp className="h-3 w-3" />
                ) : (
                  <ChevronDown className="h-3 w-3" />
                )}
              </Button>
            </div>
          </div>
          {!isRosterMinimized && (
            <div className="px-4 pb-4">
              <div className="mb-2 grid grid-cols-3 divide-x overflow-hidden rounded-md border bg-gray-50 dark:bg-gray-900">
                <RosterMetric label="Budget" value={`$${remainingBudget}`} />
                <RosterMetric label="Max bid" value={`$${maxBid}`} />
                <RosterMetric label="Paid slots" value={remainingAuctionPicks} />
              </div>
              <RosterSummary />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function RosterMetric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex min-w-0 items-baseline justify-center gap-1 whitespace-nowrap px-1.5 py-1.5">
      <span className="text-[9px] font-medium uppercase tracking-tight text-muted-foreground">
        {label}
      </span>
      <span className="text-xs font-bold tabular-nums text-foreground">
        {value}
      </span>
    </div>
  );
}
