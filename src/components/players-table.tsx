'use client';

import React, { useState, useMemo, useCallback, useDeferredValue, useRef } from 'react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PositionBadge } from '@/components/position-badge';
import { PlayerAvatar } from '@/components/player-avatar';
import { EditableAuctionValue } from '@/components/editable-auction-value';
import { PositionFilter } from '@/components/position-filter';
import { useAllPlayers, useUpdatePlayerAuctionValues } from '@/hooks/use-players';
import { useLeague } from '@/hooks/use-league';
import { SCORING_FORMAT_LABELS } from '@/lib/fantasy-scoring';
import { useActiveDraft } from '@/contexts/active-draft-context';
import { useNavigation, type FilterPosition } from '@/contexts/navigation-context';
import { useAuction } from '@/contexts/auction-context';
import { useAllDraftPicks, useUpdateDraftPickPrice } from '@/hooks/use-draft-picks';
import { useWatchlist, useAddToWatchlist, useRemoveFromWatchlist } from '@/hooks/use-watchlist';
import { usePlayerActions } from '@/hooks/use-player-actions';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Search, ExternalLink, SlidersHorizontal } from 'lucide-react';
import { Player } from '@/server/types/player';
import { DraftPickWithDetails as DraftPick } from '@/server/types/draft-pick';
import { StarRating } from './star-rating';
import { WatchlistButton } from './watchlist-button';
import { PlayerActionButton } from '@/components/player-action-button';
import { PlayerNameButton } from '@/components/player-name-button';
import { cn, toKebabCase } from '@/lib/utils';
import Link from 'next/link';
import { TierCliffAlerts } from '@/components/tier-cliff-alerts';
import { InjuryBadge } from '@/components/injury-badge';
import { usePlayerInjuries } from '@/hooks/use-player-injuries';
import type { PlayerInjury } from '@/lib/sleeper-injuries';
import { useProjectedPickLines } from '@/hooks/use-projected-pick-lines';
import type { ProjectedTeamPick } from '@/lib/snake-pick-projection';
import { compareBoardPlayers, deriveAdp, type BoardSort } from '@/lib/adp';

// Every column stays in the DOM on mobile — the low-value ones are only
// display:none via `max-md:hidden`, so colSpan stays 14 at every width.
const COLUMN_COUNT = 14;
const ROW_HEIGHT_ESTIMATE = 53;

type TableRowItem =
  | { kind: 'player'; player: Player; index: number }
  | { kind: 'line'; pick: ProjectedTeamPick };

export function PlayersTable() {
  const [updatingPlayerId, setUpdatingPlayerId] = useState<string | null>(null);
  // Local to this component only (previously lived in NavigationContext, but
  // nothing else consumes it — hoisting it out of the shared context avoids
  // re-rendering every other navigation consumer on each keystroke).
  const [searchTerm, setSearchTerm] = useState<string>('');
  const [isFilterSheetOpen, setIsFilterSheetOpen] = useState(false);
  const [sort, setSort] = useState<BoardSort>({ column: 'rank', direction: 'asc' });
  const toggleSort = (column: BoardSort['column']) => setSort(current => ({
    column,
    direction: current.column === column && current.direction === 'asc' ? 'desc' : 'asc',
  }));

  const { data: players = [], isLoading, error } = useAllPlayers();
  const { data: injuryData } = usePlayerInjuries();
  const { activePlayer } = useActiveDraft();
  const {
    showDraftedPlayers,
    setShowDraftedPlayers,
    selectedPositions,
    setSelectedPositions
  } = useNavigation();
  const { data: draftPicks = [] } = useAllDraftPicks();
  const { isReadOnly, selectedYear } = useAuction();
  const { settings } = useLeague();
  const playerActions = usePlayerActions();

  // Hoisted out of WatchlistButton: previously every row ran its own
  // useWatchlist/useAddToWatchlist/useRemoveFromWatchlist, creating ~1200
  // observers across a 400-row table and re-rendering every row on any
  // watchlist cache change. One subscription here, plus a per-player lookup
  // map, keeps WatchlistButton purely presentational.
  const { data: watchlist = [] } = useWatchlist();

  // Destructure `mutate` (documented as stable by TanStack Query v5) so the
  // useCallback handlers below don't get recreated when mutation state changes,
  // which would defeat PlayerRow's memo during value edits.
  const { mutate: mutateProjected } = useUpdatePlayerAuctionValues();
  const { mutate: mutatePrice } = useUpdateDraftPickPrice();
  const { mutate: mutateAddWatchlist } = useAddToWatchlist();
  const { mutate: mutateRemoveWatchlist } = useRemoveFromWatchlist();

  // Deferred so the input stays snappy while the large player filter recomputes
  // at lower priority behind the scenes.
  const deferredSearchTerm = useDeferredValue(searchTerm);

  // Drafted status and sale price come from the selected auction's picks
  const { draftedPlayerIds, pickByPlayerId } = useMemo(() => ({
    draftedPlayerIds: new Set(draftPicks.map(pick => pick.player_id)),
    pickByPlayerId: new Map(draftPicks.map(pick => [pick.player_id, pick])),
  }), [draftPicks]);

  // playerId -> watchlist item id, so each PlayerRow only needs a boolean +
  // a stable id rather than subscribing to the whole watchlist array.
  const watchlistItemIdByPlayerId = useMemo(() => {
    return new Map(watchlist.map(item => [item.player_id, item.id]));
  }, [watchlist]);

  // Drives the count badge on the mobile Filters button, so an active filter
  // is visible without opening the sheet.
  const activeFilterCount = selectedPositions.size + (showDraftedPlayers ? 0 : 1);

  const handlePositionToggle = (position: FilterPosition) => {
    const newSelected = new Set(selectedPositions);
    if (newSelected.has(position)) {
      newSelected.delete(position);
    } else {
      newSelected.add(position);
    }
    setSelectedPositions(newSelected);
  };

  const filteredPlayers = useMemo(() => {
    let filtered = players;

    // Filter out drafted players unless showDraftedPlayers is true
    if (!showDraftedPlayers) {
      filtered = filtered.filter(player => !draftedPlayerIds.has(player.id));
    }

    // Filter by search term
    if (deferredSearchTerm) {
      const lowerSearch = deferredSearchTerm.toLowerCase();
      filtered = filtered.filter(player =>
        player.name.toLowerCase().includes(lowerSearch)
      );
    }

    // Filter by position
    if (selectedPositions.size > 0) {
      filtered = filtered.filter(player => {
        // Check if any selected position matches
        for (const position of selectedPositions) {
          if (position === 'Flex') {
            // Flex includes RB, WR, TE
            if (['RB', 'WR', 'TE'].includes(player.position)) {
              return true;
            }
          } else {
            // Direct position match
            if (player.position === position) {
              return true;
            }
          }
        }
        return false;
      });
    }

    return [...filtered].sort((a, b) => compareBoardPlayers(a, b, sort));
  }, [players, draftedPlayerIds, deferredSearchTerm, selectedPositions, showDraftedPlayers, sort]);

  const handleUpdateProjected = useCallback((playerId: string, seasonId: string, value: number | null) => {
    setUpdatingPlayerId(playerId);
    mutateProjected({
      seasonId,
      values: { projected_auction_value: value }
    }, {
      onSettled: () => setUpdatingPlayerId(null)
    });
  }, [mutateProjected]);

  const handleUpdatePrice = useCallback((playerId: string, pickId: string, value: number | null) => {
    setUpdatingPlayerId(playerId);
    mutatePrice({
      id: pickId,
      price: value
    }, {
      onSettled: () => setUpdatingPlayerId(null)
    });
  }, [mutatePrice]);

  const handleToggleWatchlist = useCallback((playerId: string, watchlistItemId: string | undefined) => {
    if (watchlistItemId) {
      mutateRemoveWatchlist(watchlistItemId);
    } else {
      mutateAddWatchlist(playerId);
    }
  }, [mutateAddWatchlist, mutateRemoveWatchlist]);

  // Sleeper-style "your next pick" dividers, one per remaining snake turn.
  // Pick dividers assume an ascending ECR board, not an ADP or reversed board.
  const isFiltered = deferredSearchTerm.length > 0 || selectedPositions.size > 0
    || sort.column !== 'rank' || sort.direction !== 'asc';
  const pickLines = useProjectedPickLines(filteredPlayers, draftedPlayerIds, isFiltered);

  // Dividers are virtualized alongside the players rather than injected around
  // them, so each one is measured like any other row and the scroll offsets
  // stay honest.
  const rows = useMemo(() => {
    const out: TableRowItem[] = [];
    filteredPlayers.forEach((player, index) => {
      const line = pickLines.get(index);
      if (line) out.push({ kind: 'line', pick: line });
      out.push({ kind: 'player', player, index });
    });
    return out;
  }, [filteredPlayers, pickLines]);

  // Virtualization: the scroll container is the div rendered by the shadcn
  // Table component (exposed via containerRef). Rows are padded with two
  // spacer <tr>s (before/after the visible window) instead of translating
  // real rows, so <table>/<tbody> layout semantics stay intact.
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: () => ROW_HEIGHT_ESTIMATE,
    overscan: 10,
    getItemKey: (index) => {
      const row = rows[index];
      return row.kind === 'player' ? row.player.id : `line-${row.pick.pickOrder}`;
    },
  });

  const virtualRows = rowVirtualizer.getVirtualItems();
  const totalSize = rowVirtualizer.getTotalSize();
  const paddingTop = virtualRows.length > 0 ? virtualRows[0].start : 0;
  const paddingBottom = virtualRows.length > 0 ? totalSize - virtualRows[virtualRows.length - 1].end : 0;

  if (error) {
    return (
      <div className="text-center py-8 text-red-600">
        Error loading players: {error.message}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-4 max-md:gap-3">


      <div className="flex items-center justify-between shrink-0 gap-2">
        <div className="flex min-w-0 flex-1 items-center space-x-2 md:flex-none">
          <Search className="h-4 w-4 shrink-0 text-gray-500" />
          <Input
            placeholder="Search players..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="max-w-sm max-md:h-11"
          />
        </div>
        {/* Below md the pills and the drafted toggle move into a sheet — seven
            44px pills plus a checkbox row ate roughly a third of a phone
            screen before the table even started. */}
        <Sheet open={isFilterSheetOpen} onOpenChange={setIsFilterSheetOpen}>
          <SheetTrigger asChild>
            <Button variant="outline" className="h-11 shrink-0 gap-2 md:hidden">
              <SlidersHorizontal className="h-4 w-4" />
              Filters
              {activeFilterCount > 0 && (
                <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-blue-600 px-1 text-[11px] font-bold text-white">
                  {activeFilterCount}
                </span>
              )}
            </Button>
          </SheetTrigger>
          <SheetContent side="bottom" className="gap-0">
            <SheetHeader>
              <SheetTitle>Filters</SheetTitle>
            </SheetHeader>
            <div className="flex flex-col gap-4 px-4 pb-4">
              <PositionFilter
                selectedPositions={selectedPositions}
                onPositionToggle={handlePositionToggle}
              />
              <label className="flex min-h-11 items-center gap-2 text-sm font-medium">
                <input
                  type="checkbox"
                  checked={!showDraftedPlayers}
                  onChange={(e) => setShowDraftedPlayers(!e.target.checked)}
                  className="size-5"
                />
                Hide drafted players
              </label>
              {activeFilterCount > 0 && (
                <Button
                  variant="ghost"
                  className="h-11"
                  onClick={() => {
                    setSelectedPositions(new Set());
                    setShowDraftedPlayers(true);
                  }}
                >
                  Clear filters
                </Button>
              )}
            </div>
          </SheetContent>
        </Sheet>
        <div className="hidden items-center space-x-2 md:flex">
          <input
            type="checkbox"
            id="show-drafted"
            checked={!showDraftedPlayers}
            onChange={(e) => setShowDraftedPlayers(!e.target.checked)}
            className="h-4 w-4"
          />
          <Label htmlFor="show-drafted" className="text-sm font-medium">
            Hide drafted players
          </Label>
        </div>
      </div>
      <PositionFilter
        className="shrink-0 max-md:hidden"
        selectedPositions={selectedPositions}
        onPositionToggle={handlePositionToggle}
      />
      <TierCliffAlerts players={players} draftPicks={draftPicks} />
      <div className="rounded-md border flex-1 min-h-0 overflow-hidden">
        <Table
          containerRef={scrollContainerRef}
          containerClassName="h-full overflow-y-auto"
          className="max-md:text-xs max-md:[&_td]:px-1.5 max-md:[&_th]:px-1.5"
        >
          <TableHeader className="sticky top-0 z-20 bg-background">
            <TableRow>
              {/* Header text sets each column's min-width in an auto-layout
                  table, so the short mobile labels are what make the subset
                  fit 375px rather than scroll. */}
              <TableHead className="w-[100px] max-md:w-8" aria-sort={sort.column === 'rank' ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none'}>
                <button type="button" onClick={() => toggleSort('rank')} className="py-2" aria-label="Sort by rank">
                  <span className="max-md:hidden">Rank</span><span className="md:hidden">#</span>
                  {sort.column === 'rank' && (sort.direction === 'asc' ? ' ↑' : ' ↓')}
                </button>
              </TableHead>
              <TableHead className="w-[80px]" aria-sort={sort.column === 'adp' ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none'}>
                <button type="button" onClick={() => toggleSort('adp')} className="py-2" aria-label="Sort by ADP" title="Average draft position derived from this scoring board's rank + ECR vs ADP; — means unavailable">
                  ADP{sort.column === 'adp' && (sort.direction === 'asc' ? ' ↑' : ' ↓')}
                </button>
              </TableHead>
              <TableHead>Name</TableHead>
              <TableHead className="max-md:hidden">Team</TableHead>
              <TableHead className="w-[80px] max-md:hidden">Watch</TableHead>
              <TableHead className="w-[100px] max-md:hidden">Position</TableHead>
              <TableHead className="w-[120px] max-md:hidden">Pos Rank</TableHead>
              <TableHead className="w-[100px] max-md:hidden">Tier</TableHead>
              <TableHead className="w-[100px] max-md:hidden">SOS</TableHead>
              <TableHead className="w-[100px] max-md:hidden">Bye Week</TableHead>
              <TableHead className="w-[140px] max-md:w-20">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="cursor-help underline decoration-dotted underline-offset-2">
                      <span className="max-md:hidden">Projected </span>Price
                    </span>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-72">
                    Your cheat-sheet price from the league-history model: comps from past
                    drafts, recent years weighted more, scaled so the top 84 players sum to
                    the $2,400 league budget. Editable — manual edits stick until the model
                    is recalculated.
                  </TooltipContent>
                </Tooltip>
              </TableHead>
              <TableHead className="w-[140px] max-md:hidden">Actual Value</TableHead>
              <TableHead className="w-[120px] max-md:hidden">ECR vs ADP</TableHead>
              <TableHead className="w-[100px] max-md:w-14 sticky right-0 z-30 bg-background shadow-[inset_1px_0_0_0_var(--border)]">Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={COLUMN_COUNT} className="text-center py-8">
                  Loading players...
                </TableCell>
              </TableRow>
            ) : filteredPlayers.length === 0 ? (
              <TableRow>
                <TableCell colSpan={COLUMN_COUNT} className="text-center py-8">
                  {players.length === 0
                    ? `No ${SCORING_FORMAT_LABELS[settings.scoringFormat]} rankings for ${selectedYear} — import them in the Import view.`
                    : deferredSearchTerm
                      ? 'No players found matching your search.'
                      : 'No players available.'}
                </TableCell>
              </TableRow>
            ) : (
              <>
                {paddingTop > 0 && (
                  <tr aria-hidden="true">
                    <td colSpan={COLUMN_COUNT} style={{ height: paddingTop }} />
                  </tr>
                )}
                {virtualRows.map((virtualRow) => {
                  const row = rows[virtualRow.index];
                  if (row.kind === 'line') {
                    return (
                      <ProjectedPickRow
                        key={`line-${row.pick.pickOrder}`}
                        ref={rowVirtualizer.measureElement}
                        dataIndex={virtualRow.index}
                        pick={row.pick}
                      />
                    );
                  }
                  const player = row.player;
                  const watchlistItemId = watchlistItemIdByPlayerId.get(player.id);
                  return (
                    <PlayerRow
                      key={player.id}
                      ref={rowVirtualizer.measureElement}
                      dataIndex={virtualRow.index}
                      player={player}
                      injury={player.sleeper_id ? injuryData?.injuries[player.sleeper_id] : undefined}
                      isActive={activePlayer?.id === player.id}
                      isDrafted={draftedPlayerIds.has(player.id)}
                      pick={pickByPlayerId.get(player.id)}
                      isReadOnly={isReadOnly}
                      isUpdating={updatingPlayerId === player.id}
                      isPlayerDrafting={playerActions.isPlayerDrafting(player.id)}
                      canSnakeDraft={playerActions.canSnakeDraft}
                      canNominate={playerActions.canNominate}
                      isWatched={watchlistItemId !== undefined}
                      watchlistItemId={watchlistItemId}
                      onAction={playerActions.handlePlayerAction}
                      onUpdateProjected={handleUpdateProjected}
                      onUpdatePrice={handleUpdatePrice}
                      onToggleWatchlist={handleToggleWatchlist}
                    />
                  );
                })}
                {paddingBottom > 0 && (
                  <tr aria-hidden="true">
                    <td colSpan={COLUMN_COUNT} style={{ height: paddingBottom }} />
                  </tr>
                )}
              </>
            )}
          </TableBody>
        </Table>
      </div>

      <div className="text-sm text-gray-500 shrink-0">
        Showing {filteredPlayers.length} of {players.length} players
      </div>

    </div>
  );
}

// A full-width marker where the board is projected to be at one of the user's
// upcoming turns. Players above the topmost line are the ones expected to be
// gone; the block between two lines is the realistic range for that pick.
const ProjectedPickRow = React.forwardRef<
  HTMLTableRowElement,
  { pick: ProjectedTeamPick; dataIndex: number }
>(function ProjectedPickRow({ pick, dataIndex }, ref) {
  const onTheClock = pick.picksAway === 0;
  const label = `${pick.round}.${String(pick.pickInRound).padStart(2, '0')}`;
  return (
    <TableRow
      ref={ref}
      data-index={dataIndex}
      className="hover:bg-transparent border-0"
    >
      <TableCell colSpan={COLUMN_COUNT} className="p-0">
        <div
          className={cn(
            'flex items-center gap-2 border-y-2 border-dashed px-2 py-1 text-[11px] font-semibold uppercase tracking-wide',
            onTheClock
              ? 'border-emerald-500 bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300'
              : 'border-blue-400 bg-blue-50/70 text-blue-700 dark:border-blue-700 dark:bg-blue-950/30 dark:text-blue-300',
          )}
        >
          <span>{onTheClock ? 'Your pick' : 'Your next pick'}</span>
          <span className="font-mono normal-case">{label}</span>
          <span className="font-normal normal-case tracking-normal opacity-80">
            {onTheClock
              ? "you're on the clock"
              : `${pick.picksAway} ${pick.picksAway === 1 ? 'pick' : 'picks'} away`}
          </span>
        </div>
      </TableCell>
    </TableRow>
  );
});

ProjectedPickRow.displayName = 'ProjectedPickRow';

interface PlayerRowProps {
  player: Player;
  injury: PlayerInjury | undefined;
  isActive: boolean;
  isDrafted: boolean;
  pick: DraftPick | undefined;
  isReadOnly: boolean;
  isUpdating: boolean;
  isPlayerDrafting: boolean;
  canSnakeDraft: boolean;
  canNominate: boolean;
  isWatched: boolean;
  watchlistItemId: string | undefined;
  dataIndex: number;
  onAction: (player: Player) => void;
  onUpdateProjected: (playerId: string, seasonId: string, value: number | null) => void;
  onUpdatePrice: (playerId: string, pickId: string, value: number | null) => void;
  onToggleWatchlist: (playerId: string, watchlistItemId: string | undefined) => void;
}

const PlayerRow = React.memo(React.forwardRef<HTMLTableRowElement, PlayerRowProps>(function PlayerRow({
  player,
  injury,
  isActive,
  isDrafted,
  pick,
  isReadOnly,
  isUpdating,
  isPlayerDrafting,
  canSnakeDraft,
  canNominate,
  isWatched,
  watchlistItemId,
  dataIndex,
  onAction,
  onUpdateProjected,
  onUpdatePrice,
  onToggleWatchlist,
}, ref) {
  return (
    <TableRow
      ref={ref}
      data-index={dataIndex}
      className={cn(
        isActive && "bg-blue-50 border-blue-200 dark:bg-blue-900/20 dark:border-blue-800",
        isDrafted && "opacity-60"
      )}
    >
      <TableCell className="font-medium">{player.rank}</TableCell>
      <TableCell className="tabular-nums">{deriveAdp(player.rank, player.ecr_vs_adp) ?? '—'}</TableCell>
      {/* max-w on the cell is what actually lets the name truncate: in an
          auto-layout table the column is otherwise sized to its content's
          min-width, and `truncate` alone never kicks in. */}
      <TableCell className={cn("font-medium max-md:max-w-[200px]", isDrafted && "line-through")}>
        {/* gap-2, not space-x-2: gap ignores the display:none children below,
            so hiding the link/star at one breakpoint leaves no phantom margin. */}
        <div className="flex min-w-0 items-center gap-2 max-md:gap-1.5">
          <PlayerAvatar
            name={player.name}
            position={player.position}
            team={player.team}
            sleeperId={player.sleeper_id}
            espnId={player.espn_id}
            size={32}
            className="max-md:size-6!"
          />
          {/* Below md the Position/Team columns are gone, so the badge and team
              ride under the name instead — one column's worth of width back for
              the name itself, which is what actually needs it. */}
          <div className="flex min-w-0 flex-col">
            <PlayerNameButton player={player} className="min-w-0 truncate max-md:py-1" />
            {/* One joined string, not sibling nodes: the flex `gap` applies
                between children, which would space the separators off their
                values. Pos Rank/Tier/Bye Week columns are `max-md:hidden`, so
                this line is where that data lives on a phone. */}
            <span className="flex items-center gap-1.5 pb-0.5 text-[10px] text-muted-foreground md:hidden">
              <PositionBadge position={player.position} className="h-4 px-1 text-[9px]" />
              {/* whitespace-normal: the table cell is `whitespace-nowrap`, which
                  would clip this line rather than let it wrap. */}
              <span className="min-w-0 whitespace-normal leading-tight">
                {[
                  player.team,
                  player.position_rank && `${player.position}${player.position_rank}`,
                  player.tier && `T${player.tier}`,
                  player.bye_week && `BYE ${player.bye_week}`,
                ].filter(Boolean).join(' · ')}
              </span>
            </span>
          </div>
          <Link
            target="_blank"
            title="FantasyPros"
            className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 max-md:hidden"
            href={`https://www.fantasypros.com/nfl/players/${toKebabCase(player.name)}.php`}
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </Link>
          {player.is_rookie && (
            <div className="flex h-4 min-w-4 items-center justify-center rounded-full bg-purple-600 px-1 text-[9px] font-bold leading-none text-white">
              R
            </div>
          )}
          {injury && <InjuryBadge injury={injury} compact />}
          {/* Stand-in for the Watch column, which is hidden below md. */}
          <WatchlistButton
            isWatched={isWatched}
            onToggle={() => onToggleWatchlist(player.id, watchlistItemId)}
            className="ml-auto h-11 w-7 shrink-0 p-0 md:hidden"
          />
        </div>
      </TableCell>
      <TableCell className="max-md:hidden">{player.team}</TableCell>
      <TableCell className="max-md:hidden">
        <WatchlistButton
          isWatched={isWatched}
          onToggle={() => onToggleWatchlist(player.id, watchlistItemId)}
          className="h-8 w-8 p-0"
        />
      </TableCell>
      <TableCell className="max-md:hidden">
        <PositionBadge position={player.position} />
      </TableCell>
      <TableCell className="text-center max-md:hidden">{player.position_rank}</TableCell>
      <TableCell className="text-center max-md:hidden">{player.tier}</TableCell>
      <TableCell className="text-center max-md:hidden">
        <StarRating value={player.sos} />
      </TableCell>
      <TableCell className="text-center max-md:hidden">{player.bye_week}</TableCell>
      <TableCell>
        <EditableAuctionValue
          value={player.projected_auction_value}
          onSave={(value) => onUpdateProjected(player.id, player.season_id, value)}
          isLoading={isUpdating}
          placeholder="Projected Price"
          hideEditOnMobile
        />
      </TableCell>
      <TableCell className="max-md:hidden">
        {pick && !isReadOnly ? (
          <EditableAuctionValue
            value={pick.price}
            onSave={(value) => onUpdatePrice(player.id, pick.id, value)}
            isLoading={isUpdating}
            placeholder="Actual"
          />
        ) : (
          <span className="text-sm font-medium min-w-[2rem]">
            {pick?.price != null ? `$${pick.price}` : '-'}
          </span>
        )}
      </TableCell>
      <TableCell className="text-center max-md:hidden">
        <span className={`font-medium ${(player.ecr_vs_adp ?? 0) > 0
          ? 'text-green-600'
          : (player.ecr_vs_adp ?? 0) < 0
            ? 'text-red-600'
            : 'text-gray-600'
          }`}>
          {(player.ecr_vs_adp ?? 0) > 0 ? '+' : ''}{player.ecr_vs_adp ?? '—'}
        </span>
      </TableCell>
      <TableCell className="sticky right-0 z-10 bg-background shadow-[inset_1px_0_0_0_var(--border)]">
        <PlayerActionButton
          player={player}
          isDrafted={isDrafted}
          isPlayerDrafting={isPlayerDrafting}
          canSnakeDraft={canSnakeDraft}
          canNominate={canNominate}
          onAction={onAction}
          className="h-8 px-3 max-md:h-11 max-md:px-2.5"
        />
      </TableCell>
    </TableRow>
  );
}));

PlayerRow.displayName = 'PlayerRow';
