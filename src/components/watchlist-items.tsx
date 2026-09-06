'use client';

import React, { useState, useMemo, useEffect } from 'react';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import {
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { PositionBadge } from '@/components/position-badge';
import { PlayerAvatar } from '@/components/player-avatar';
import { PlayerNameButton } from '@/components/player-name-button';
import { PlayerActionButton } from '@/components/player-action-button';
import { useWatchlist, useUpdateWatchlistOrder, useRemoveFromWatchlist } from '@/hooks/use-watchlist';
import { useAllDraftPicks } from '@/hooks/use-draft-picks';
import { useIsSnakeLeague } from '@/hooks/use-league';
import { usePlayerActions } from '@/hooks/use-player-actions';
import { isExpectedGoneBeforeNextTurn } from '@/lib/snake-survival';
import { useSnakeSurvival } from '@/hooks/use-snake-survival';
import { useActiveDraft } from '@/contexts/active-draft-context';
import { WatchlistWithDetails } from '@/server/types/watchlist';
import { WatchlistFilter } from '@/components/watchlist-sidebar';
import { type FilterPosition } from '@/contexts/navigation-context';
import { cn } from '@/lib/utils';

interface SortableWatchlistItemProps {
  item: WatchlistWithDetails;
  isDrafted: boolean;
  price: number | null;
  survival: boolean | null;
  playerActions: ReturnType<typeof usePlayerActions>;
}

function SortableWatchlistItem({ item, isDrafted, price, survival, playerActions }: SortableWatchlistItemProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: item.id });

  const removeFromWatchlist = useRemoveFromWatchlist();

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  const hasAuctionValue = price !== null && price > 0;

  // We need to import useActiveDraft to check if this player is active
  const { activePlayer } = useActiveDraft();
  const isActive = activePlayer?.id === item.player.id;

  const handleRemove = () => {
    removeFromWatchlist.mutate(item.id);
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        "flex items-center gap-2 p-2 border rounded text-xs",
        isActive
          ? "bg-blue-50 border-blue-200 dark:bg-blue-900/20 dark:border-blue-800"
          : "bg-white dark:bg-gray-900 border-gray-200 dark:border-gray-700",
        isDragging && "opacity-50 shadow-lg",
        isDrafted && "opacity-60"
      )}
    >
      <div
        {...attributes}
        {...listeners}
        className="flex h-9 w-6 shrink-0 touch-none items-center justify-center text-gray-400 hover:text-gray-600 active:cursor-grabbing sm:h-auto sm:w-auto sm:cursor-grab dark:hover:text-gray-300"
      >
        <GripVertical className="h-3 w-3" />
      </div>

      <PlayerAvatar
        name={item.player.name}
        position={item.player.position}
        team={item.player.team}
        sleeperId={item.player.sleeper_id}
        espnId={item.player.espn_id}
        size={24}
      />

      <div className="flex-1 min-w-0">
        <div className="flex items-center space-x-1 mb-1">
          <PositionBadge position={item.player.position} className="text-xs h-4 px-1" />
          <PlayerNameButton
            player={item.player}
            className={cn('truncate font-medium', isDrafted && 'line-through')}
          />
          {hasAuctionValue && (
            <Badge variant="secondary" className="text-xs px-1 h-4">
              ${price}
            </Badge>
          )}
          {survival != null && (
            survival ? (
              <Badge className="bg-amber-100 px-1 text-[10px] text-amber-800 hover:bg-amber-100 dark:bg-amber-900/30 dark:text-amber-300">
                Won&apos;t last
              </Badge>
            ) : (
              <span className="text-[10px] text-gray-400">Likely there</span>
            )
          )}
        </div>
        <div className="text-xs text-gray-500">
          {item.player.team} • Bye {item.player.bye_week} • #{item.player.rank}
        </div>
      </div>

      <div className="flex items-center space-x-1">
        <PlayerActionButton
          player={item.player}
          isDrafted={isDrafted}
          isPlayerDrafting={playerActions.isPlayerDrafting(item.player.id)}
          canSnakeDraft={playerActions.canSnakeDraft}
          canNominate={playerActions.canNominate}
          onAction={playerActions.handlePlayerAction}
          size="sm"
          className="h-9 px-2.5 text-xs sm:h-6 sm:px-2"
        />
        <Button
          size="sm"
          variant="ghost"
          onClick={handleRemove}
          aria-label="Remove from watchlist"
          className="h-9 w-9 p-0 text-gray-400 hover:text-red-500 sm:h-6 sm:w-6"
        >
          <X className="h-3 w-3" />
        </Button>
      </div>
    </div>
  );
}

interface WatchlistItemsProps {
  filter: WatchlistFilter;
  selectedPositions: Set<FilterPosition>;
}

export function WatchlistItems({ filter, selectedPositions }: WatchlistItemsProps) {
  const { data: watchlist = [], isLoading } = useWatchlist();
  const { data: draftPicks = [] } = useAllDraftPicks();
  const isSnakeLeague = useIsSnakeLeague();
  const updateWatchlistOrder = useUpdateWatchlistOrder();
  const playerActions = usePlayerActions();

  // Same survival signal as the board (NFI-83), from the shared hook so the
  // two surfaces cannot disagree about board-wide ADP.
  const { showSurvival, picksAway, currentOverall } = useSnakeSurvival();

  const [optimisticItems, setOptimisticItems] = useState<WatchlistWithDetails[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [pendingUpdate, setPendingUpdate] = useState(false);

  // Clear optimistic state when server data matches our expected order
  useEffect(() => {
    if (pendingUpdate && optimisticItems.length > 0 && watchlist.length > 0) {
      // Check if server data matches our optimistic order
      const optimisticOrder = optimisticItems.map(item => item.id).join(',');
      const serverOrder = watchlist.map(item => item.id).join(',');

      if (optimisticOrder === serverOrder) {
        // Server data matches our optimistic state, safe to clear
        setOptimisticItems([]);
        setPendingUpdate(false);
      }
    }
  }, [watchlist, optimisticItems, pendingUpdate]);

  // Use the optimistic items during drag, otherwise use server data
  const currentItems = useMemo(() => {
    // If we have optimistic items and are dragging or have a pending update, use them
    if (optimisticItems.length > 0 && (isDragging || pendingUpdate)) {
      return optimisticItems;
    }
    // Otherwise use server data
    return watchlist;
  }, [optimisticItems, watchlist, isDragging, pendingUpdate]);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  // Get drafted player IDs and sale prices for the selected auction
  // (prices hidden in snake leagues — the badge reads hasAuctionValue).
  const draftedPlayerIds = new Set(draftPicks.map(pick => pick.player_id));
  const priceByPlayerId = isSnakeLeague
    ? new Map<string, number>()
    : new Map(draftPicks.map(pick => [pick.player_id, pick.price]));

  // Filter items based on filter selection
  const filteredItems = currentItems.filter(item => {
    const isDrafted = draftedPlayerIds.has(item.player_id);

    // Filter by drafted status
    let statusMatch = true;
    switch (filter) {
      case 'available':
        statusMatch = !isDrafted;
        break;
      case 'drafted':
        statusMatch = isDrafted;
        break;
      default:
        statusMatch = true;
    }

    // Filter by position
    let positionMatch = true;
    if (selectedPositions.size > 0) {
      positionMatch = false;
      for (const position of selectedPositions) {
        if (position === 'Flex') {
          // Flex includes RB, WR, TE
          if (['RB', 'WR', 'TE'].includes(item.player.position)) {
            positionMatch = true;
            break;
          }
        } else {
          // Direct position match
          if (item.player.position === position) {
            positionMatch = true;
            break;
          }
        }
      }
    }

    return statusMatch && positionMatch;
  });

  function handleDragStart() {
    setIsDragging(true);
    setOptimisticItems(watchlist);
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;

    if (active.id !== over?.id) {
      const oldIndex = optimisticItems.findIndex((item) => item.id === active.id);
      const newIndex = optimisticItems.findIndex((item) => item.id === over?.id);

      if (oldIndex !== -1 && newIndex !== -1) {
        const newItems = arrayMove(optimisticItems, oldIndex, newIndex);

        // Keep optimistic state until server responds
        setOptimisticItems(newItems);

        // Update watch_order for all items
        const updates = newItems.map((item, index) => ({
          id: item.id,
          watch_order: index + 1,
        }));

        // Send the update to the server
        updateWatchlistOrder.mutate(updates, {
          onSuccess: () => {
            // Reset drag state and mark as pending update
            setIsDragging(false);
            setPendingUpdate(true);
            // The useEffect will clear optimistic items when server data matches
          },
          onError: () => {
            // Revert to original state on error
            setIsDragging(false);
            setPendingUpdate(false);
            setOptimisticItems([]);
          }
        });
      }
    } else {
      // No change, just reset drag state
      setIsDragging(false);
    }
  }

  if (isLoading) {
    return (
      <div className="text-center py-4 text-sm text-gray-500">
        Loading watchlist...
      </div>
    );
  }

  if (filteredItems.length === 0) {
    return (
      <div className="text-center py-4 text-sm text-gray-500">
        {filter === 'available' ? 'No available players in watchlist' :
          filter === 'drafted' ? 'No drafted players in watchlist' :
            'No players in watchlist'}
      </div>
    );
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
    >
      <SortableContext items={filteredItems} strategy={verticalListSortingStrategy}>
        <div className="space-y-2">
          {filteredItems.map((item) => {
            const isDrafted = draftedPlayerIds.has(item.player_id);
            return (
              <SortableWatchlistItem
                key={item.id}
                item={item}
                isDrafted={isDrafted}
                price={priceByPlayerId.get(item.player_id) ?? null}
                survival={showSurvival && !isDrafted
                  ? isExpectedGoneBeforeNextTurn(item.player, picksAway, currentOverall)
                  : null}
                playerActions={playerActions}
              />
            );
          })}
        </div>
      </SortableContext>
    </DndContext>
  );
}
