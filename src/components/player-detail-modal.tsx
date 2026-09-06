'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { ArrowLeftRight } from 'lucide-react';

import { Button } from '@/components/ui/button';
import type { ScoringFormat } from '@/lib/fantasy-scoring';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { PositionBadge } from '@/components/position-badge';
import { PlayerAvatar } from '@/components/player-avatar';
import {
  PlayerSeasonHistoryTable,
  PlayerTargetPriceSection,
} from '@/components/player-history-sections';
import { PlayerNewsSection } from '@/components/player-news-section';
import { Player } from '@/server/types/player';
import { usePlayerDetail } from '@/contexts/player-detail-context';
import { useIsSnakeLeague } from '@/hooks/use-league';
import { usePlayerInjuries } from '@/hooks/use-player-injuries';
import { useAllDraftPicks } from '@/hooks/use-draft-picks';
import { InjuryBadge } from '@/components/injury-badge';

// Kept out of the initial modal bundle: the game log is below the fold and only
// matters once the user scrolls to it.
const PlayerGameLogSection = dynamic(() =>
  import('@/components/player-gamelog-section').then(mod => mod.PlayerGameLogSection)
);

// The overview shows two summaries; 'gamelog' and 'pricing' are the drilled-in
// tables behind them, and 'news' the full feed behind the footer teaser.
type ModalView = 'overview' | 'gamelog' | 'pricing' | 'news';

interface PlayerDetailModalProps {
  player: Player;
  isOpen: boolean;
  onClose: () => void;
}

export function PlayerDetailModal({ player, isOpen, onClose }: PlayerDetailModalProps) {
  const { showPlayerCompare } = usePlayerDetail();
  const [view, setView] = useState<ModalView>('overview');
  // Owned here, not in the chart, so drilling into the table and coming back
  // keeps the season and scoring format the user picked.
  const [logSeason, setLogSeason] = useState<number | null>(null);
  const [logFormat, setLogFormat] = useState<ScoringFormat | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const { data: injuryData } = usePlayerInjuries(isOpen);
  const { data: draftPicks = [] } = useAllDraftPicks();
  const injury = player.sleeper_id ? injuryData?.injuries[player.sleeper_id] : undefined;
  // No prices exist in a snake league: the target-price section and its
  // pricing drill-in hide; gamelog and news carry over untouched.
  const isSnakeLeague = useIsSnakeLeague();
  const draftedPrice = useMemo(
    () => draftPicks.find(pick => pick.player_id === player.id)?.price,
    [draftPicks, player.id]
  );

  useEffect(() => {
    if (isOpen) {
      setView('overview');
      setLogSeason(null);
      setLogFormat(null);
    }
  }, [isOpen, player.id]);

  // Every view shares one scroll container, so without this a drill-in would
  // open at whatever offset the overview was left at — usually mid-table.
  useEffect(() => {
    bodyRef.current?.scrollTo({ top: 0 });
  }, [view]);

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent
        aria-describedby={undefined}
        onEscapeKeyDown={(event) => {
          if ((event.target as HTMLElement).closest('[data-price-editor]')) event.preventDefault();
        }}
        className="flex flex-col gap-0 overflow-hidden md:max-h-[88dvh] md:max-w-2xl md:rounded-2xl md:p-0"
      >
        <DialogHeader className="z-10 shrink-0 border-b bg-background py-4 pl-5 pr-12 md:pl-6">
          <DialogTitle className="flex min-w-0 items-center gap-3 text-left">
            <PlayerAvatar
              name={player.name}
              position={player.position}
              team={player.team}
              sleeperId={player.sleeper_id}
              espnId={player.espn_id}
              size={40}
            />
            <span className="truncate text-lg">{player.name}</span>
            <PositionBadge position={player.position} className="hidden h-5 px-2 text-[11px] md:inline-flex" />
            <span className="hidden truncate text-sm font-normal text-muted-foreground md:inline">
              {player.team || 'FA'} · #{player.rank || '—'} overall · {player.position}{player.position_rank || '—'}
            </span>
            <span className="ml-auto shrink-0 pr-1 text-sm font-semibold tabular-nums">
              {view === 'news' && draftedPrice != null ? `$${draftedPrice}` : null}
            </span>
          </DialogTitle>
          {/* Below md this is a real row under the title carrying the meta line
              plus Compare/health; from md up it's lifted out of flow into the
              header's right side and only the actions remain. */}
          <div className="flex items-center justify-between gap-2 md:absolute md:right-12 md:top-[22px] md:z-20 md:justify-end">
            {/* truncate, not wrap: sharing the row with Compare/health leaves
                this ~140px, and three wrapped lines push the header taller than
                the actions beside it. */}
            <span className="min-w-0 truncate text-xs text-muted-foreground md:hidden">
              {player.team || 'FA'} · #{player.rank || '—'} · {player.position}{player.position_rank || '—'}
            </span>
            {view === 'overview' && (
              <div className="flex shrink-0 items-center gap-2 md:gap-3">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => showPlayerCompare(player)}
                  className="h-7 gap-1.5 px-2 text-xs font-medium text-muted-foreground max-md:min-h-11"
                >
                  <ArrowLeftRight className="size-3.5" /> Compare
                </Button>
                {injury ? (
                  <InjuryBadge injury={injury} />
                ) : (
                  <span className="flex items-center gap-1.5 text-xs font-medium text-emerald-600">
                    <span className="h-2 w-2 rounded-full bg-emerald-500" /> Healthy
                  </span>
                )}
              </div>
            )}
          </div>
        </DialogHeader>

        {/* One scroll container for every view, so drilling in can reset the
            offset — see the effect above. */}
        <div ref={bodyRef} className="min-h-0 flex-1 overflow-y-auto">
          {view === 'overview' && (
            <>
              {/* The overview is the two summaries only — target price with its comps
                  distribution, then scoring by week. Each drills into its own table. */}
              {!isSnakeLeague && (
                <PlayerTargetPriceSection player={player} onShowTable={() => setView('pricing')} />
              )}
              <PlayerGameLogSection
                player={player}
                enabled={isOpen}
                mode="chart"
                season={logSeason}
                format={logFormat}
                onSeasonChange={setLogSeason}
                onFormatChange={setLogFormat}
                onShowTable={() => setView('gamelog')}
              />
            </>
          )}

          {view === 'gamelog' && (
            <PlayerGameLogSection
              player={player}
              enabled={isOpen}
              mode="table"
              season={logSeason}
              format={logFormat}
              onSeasonChange={setLogSeason}
              onFormatChange={setLogFormat}
              onBack={() => setView('overview')}
            />
          )}

          {view === 'pricing' && !isSnakeLeague && (
            <>
              <div className="flex items-center gap-4 border-b bg-muted/20 px-5 py-3 sm:px-6">
                <button
                  type="button"
                  onClick={() => setView('overview')}
                  className="text-xs font-semibold hover:underline"
                >
                  ← Overview
                </button>
                <span className="text-sm font-semibold">Price history</span>
              </div>
              <PlayerSeasonHistoryTable player={player} enabled={isOpen} />
            </>
          )}

          {view === 'news' && (
            <PlayerNewsSection
              player={player}
              enabled={isOpen}
              mode="full"
              onBack={() => setView('overview')}
            />
          )}
        </div>

        {/* Pinned below the scroll area rather than trailing the content, so the
            latest headline is visible without scrolling for it. */}
        {view === 'overview' && (
          <div className="shrink-0">
            <PlayerNewsSection
              player={player}
              enabled={isOpen}
              mode="teaser"
              onShowAll={() => setView('news')}
            />
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
