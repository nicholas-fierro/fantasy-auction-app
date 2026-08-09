'use client';

import { useMemo } from 'react';
import dynamic from 'next/dynamic';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Player } from '@/server/types/player';
import { HistoricalValue } from '@/server/types/history';
import { useAllPlayers, usePlayerSeasons, useUpdatePlayerAuctionValues } from '@/hooks/use-players';
import { useHistoricalValues } from '@/hooks/use-history';
import { useAuction } from '@/contexts/auction-context';
import { buildHistoryIndex, estimateCompDetail } from '@/lib/estimated-value';
import { WatchlistButton } from '@/components/watchlist-button';
import { PlayerActionButton } from '@/components/player-action-button';
import { MockBidActions } from '@/components/mock-bid-actions';
import { useWatchlist, useAddToWatchlist, useRemoveFromWatchlist } from '@/hooks/use-watchlist';
import { usePlayerActions } from '@/hooks/use-player-actions';
import { useAllDraftPicks } from '@/hooks/use-draft-picks';
import { EditableAuctionValue } from '@/components/editable-auction-value';
import { useMockDraft } from '@/contexts/mock-draft-context';

interface PlayerHistorySectionsProps {
  player: Player;
  enabled?: boolean;
}

const PlayerCompsDistribution = dynamic(() =>
  import('@/components/player-comps-distribution').then(mod => mod.PlayerCompsDistribution)
);

// Split into two exports because the modal places them differently: the target
// price and its comps chart stay visible above the tab bar, while the
// year-by-year price table sits inside the Pricing tab. Both call the same
// hooks; TanStack Query serves the second caller from cache.

// Target price, comps distribution, and the watchlist/nominate actions. No
// `enabled` gate — everything here comes from league-wide queries the modal's
// openers have already loaded, so there is no per-player fetch to defer.
export function PlayerTargetPriceSection({
  player,
  onShowTable,
}: {
  player: Player;
  onShowTable?: () => void;
}) {
  const { selectedAuction, selectedYear } = useAuction();
  const { data: currentPlayers = [] } = useAllPlayers();
  const { data: historyRows = [] } = useHistoricalValues();
  const { data: watchlist = [] } = useWatchlist();
  const { data: draftPicks = [] } = useAllDraftPicks();
  const { mutate: addToWatchlist } = useAddToWatchlist();
  const { mutate: removeFromWatchlist } = useRemoveFromWatchlist();
  const playerActions = usePlayerActions();
  const mockDraft = useMockDraft();
  const actionPlayer = currentPlayers.find(candidate => candidate.id === player.id) ?? null;
  const pendingBid = mockDraft.pending?.player.id === actionPlayer?.id ? mockDraft.pending : null;
  const { mutate: updateProjected, isPending: isSavingProjected, data: savedSeason } =
    useUpdatePlayerAuctionValues();
  const projectedValue = savedSeason?.id === player.season_id
    ? savedSeason.projected_auction_value
    : actionPlayer
      ? actionPlayer.projected_auction_value
      : player.projected_auction_value;
  const watchlistItem = watchlist.find(item => item.player_id === player.id);
  const isDrafted = draftPicks.some(pick => pick.player_id === player.id);

  const historyIndex = useMemo(() => buildHistoryIndex(historyRows), [historyRows]);

  const detail = useMemo(
    () =>
      estimateCompDetail(
        historyIndex,
        player.position,
        player.position_rank,
        player.rank,
        selectedYear
      ),
    [historyIndex, player.position, player.position_rank, player.rank, selectedYear]
  );

  return (
    <section className="grid border-b sm:grid-cols-[215px_minmax(0,1fr)]">
      <div className="border-b px-5 py-4 sm:border-b-0 sm:border-r sm:px-6">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-violet-600 dark:text-violet-400">
          Target Price
        </div>
        <div className="mt-0.5 flex items-end justify-between gap-3 sm:justify-start sm:gap-3.5">
          <div className="text-[40px] font-semibold leading-none tracking-tight tabular-nums sm:text-5xl">
            {detail ? `$${detail.estimate}` : '—'}
          </div>
          <EditableAuctionValue
            value={projectedValue}
            onSave={(value) =>
              updateProjected({
                seasonId: player.season_id,
                values: { projected_auction_value: value },
              })
            }
            isLoading={isSavingProjected}
            placeholder="Projected Price"
            variant="price-cluster"
            className="items-end sm:items-start"
          />
        </div>
        <div className="mt-1 text-xs text-muted-foreground">
          {detail
            ? `range $${detail.p25}–$${detail.p75} · ${detail.compCount} comps`
            : 'No comparable prices'}
        </div>
        <div className="mt-4 flex gap-2">
          <WatchlistButton
            isWatched={!!watchlistItem}
            onToggle={() => watchlistItem ? removeFromWatchlist(watchlistItem.id) : addToWatchlist(player.id)}
            size="default"
            className="h-11 w-12 px-0"
          />
          {selectedAuction && actionPlayer && (
            pendingBid ? (
              <MockBidActions
                pending={pendingBid}
                userMaxBid={mockDraft.userMaxBid}
                onPass={mockDraft.pass}
                onBid={mockDraft.counter}
                disabled={mockDraft.paused}
              />
            ) : (
              <PlayerActionButton
                player={actionPlayer}
                isDrafted={isDrafted}
                isPlayerDrafting={playerActions.isPlayerDrafting(actionPlayer.id)}
                canSnakeDraft={playerActions.canSnakeDraft}
                canNominate={playerActions.canNominate}
                onAction={playerActions.handlePlayerAction}
                size="default"
                showLabel
                hideWhenActive
                className="h-11 flex-1"
              />
            )
          )}
        </div>
      </div>
      <div className="min-w-0 px-5 py-3 sm:px-6">
        {detail && (
          <PlayerCompsDistribution
            estimate={detail.estimate}
            p25={detail.p25}
            p75={detail.p75}
            compCount={detail.compCount}
            window={detail.window}
            comps={detail.comps}
            playerPosition={player.position}
            playerRank={player.rank}
            playerPositionRank={player.position_rank}
            compact
          />
        )}
        {onShowTable && (
          <div className="mt-1 flex justify-end">
            <button
              type="button"
              onClick={onShowTable}
              className="text-xs font-semibold text-blue-600 hover:underline dark:text-blue-400"
            >
              Price history →
            </button>
          </div>
        )}
      </div>
    </section>
  );
}

// Year-by-year projected price vs. the price the player actually went for.
export function PlayerSeasonHistoryTable({ player, enabled = true }: PlayerHistorySectionsProps) {
  const { data: seasons = [], isLoading } = usePlayerSeasons(player.id, enabled);
  const { data: historyRows = [] } = useHistoricalValues();

  // Authoritative actual price + source per year for this player, from the shared
  // historical dataset (official pick prices win; imported values fall back).
  // Synthesized 'undrafted' rows are display-only noise here — a player who
  // went undrafted has no actual price to show, so they're excluded and the
  // row falls back to '—' below rather than showing a misleading $0.
  const historyByYear = useMemo(() => {
    const map = new Map<number, HistoricalValue>();
    for (const row of historyRows) {
      if (row.player_id === player.id && row.source !== 'undrafted') map.set(row.year, row);
    }
    return map;
  }, [historyRows, player.id]);

  return (
    <section className="px-5 py-3 sm:px-6">
      <div className="mb-1 flex items-center justify-between gap-4">
        <h3 className="text-sm font-semibold">Season history</h3>
        <span className="text-[11px] text-muted-foreground">projected price vs. actual draft price</span>
      </div>
      <div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Year</TableHead>
              <TableHead className="text-center">Rank</TableHead>
              <TableHead className="text-center">Pos</TableHead>
              <TableHead className="text-right">Projected Price</TableHead>
              <TableHead className="text-right">Actual</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={5} className="text-center py-6">
                  Loading…
                </TableCell>
              </TableRow>
            ) : seasons.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="text-center py-6 text-gray-500">
                  No season data.
                </TableCell>
              </TableRow>
            ) : (
              seasons.map((season) => {
                const hist = historyByYear.get(season.year);
                const actual = hist ? hist.price : season.actual_auction_value;
                const sourceLabel = hist
                  ? hist.source === 'official'
                    ? 'official draft'
                    : 'imported'
                  : season.actual_auction_value != null
                    ? 'imported'
                    : null;
                return (
                  <TableRow key={season.id}>
                    <TableCell className="font-medium">{season.year}</TableCell>
                    <TableCell className="text-center tabular-nums">
                      {season.rank > 0 ? season.rank : '—'}
                    </TableCell>
                    <TableCell className="text-center tabular-nums">
                      {season.position_rank > 0 ? season.position_rank : '—'}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {season.projected_auction_value != null
                        ? `$${season.projected_auction_value}`
                        : '—'}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {actual != null ? (
                        <span className="flex items-center justify-end gap-1">
                          <span className="font-medium">${actual}</span>
                          {sourceLabel && (
                            <span className="text-xs text-gray-400">
                              {sourceLabel === 'official draft' ? 'official' : sourceLabel}
                            </span>
                          )}
                        </span>
                      ) : (
                        '—'
                      )}
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}
