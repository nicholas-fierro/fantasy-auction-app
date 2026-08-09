'use client';

import { useMemo, useState } from 'react';
import { ArrowLeftRight, Check, ChevronRight, Loader2, Search, Trophy } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { PlayerAvatar } from '@/components/player-avatar';
import { PlayerActionButton } from '@/components/player-action-button';
import { PositionBadge } from '@/components/position-badge';
import { buildLocalDraftComparison } from '@/lib/draft-comparison';
import { cn } from '@/lib/utils';
import { useFantasyProsComparison } from '@/hooks/use-fantasypros-comparison';
import { usePlayerActions } from '@/hooks/use-player-actions';
import { useAllDraftPicks } from '@/hooks/use-draft-picks';
import { useAllPlayers } from '@/hooks/use-players';
import type { Player } from '@/server/types/player';

const POSITIONS = ['ALL', 'QB', 'RB', 'WR', 'TE', 'K', 'DST'];

function PlayerPicker({
  label,
  selected,
  excludedId,
  players,
  onSelect,
  anchor,
}: {
  label: string;
  selected?: Player;
  excludedId?: string;
  players: Player[];
  onSelect: (player: Player) => void;
  anchor?: Player;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [position, setPosition] = useState('ALL');
  const matches = useMemo(() => {
    const filtered = players
      .filter((player) => player.id !== excludedId)
      .filter((player) => position === 'ALL' || player.position === position)
      .filter((player) => player.name.toLowerCase().includes(search.toLowerCase()));

    // With no search query, prioritize players near the anchor's ranking
    // band (same position first, then closest overall rank) instead of the
    // raw overall-rank order — otherwise the second slot always surfaces the
    // top overall players regardless of the first player's actual range.
    if (anchor && !search.trim()) {
      const banded = [...filtered].sort((a, b) => {
        const aSamePos = a.position === anchor.position ? 0 : 1;
        const bSamePos = b.position === anchor.position ? 0 : 1;
        if (aSamePos !== bSamePos) return aSamePos - bSamePos;
        return Math.abs(a.rank - anchor.rank) - Math.abs(b.rank - anchor.rank);
      });
      return banded.slice(0, 60);
    }

    return filtered.slice(0, 60);
  }, [players, excludedId, position, search, anchor]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button className="flex min-h-24 w-full items-center gap-3 rounded-xl border border-dashed border-slate-300 bg-white p-4 text-left transition hover:border-blue-400 hover:bg-blue-50/40 dark:border-slate-700 dark:bg-slate-950 dark:hover:bg-blue-950/20">
          {selected ? <PlayerAvatar name={selected.name} position={selected.position} team={selected.team} sleeperId={selected.sleeper_id} espnId={selected.espn_id} size={48} /> : <div className="grid size-12 place-items-center rounded-full bg-slate-100 text-slate-500 dark:bg-slate-800"><Search className="size-5" /></div>}
          <span className="min-w-0">
            <span className="block text-xs font-medium uppercase tracking-wide text-slate-500">{label}</span>
            {selected ? <><span className="block truncate font-semibold">{selected.name}</span><span className="text-sm text-slate-500">{selected.team} · {selected.position}#{selected.position_rank}</span></> : <span className="block font-semibold text-slate-700 dark:text-slate-200">Choose a player</span>}
          </span>
          <ChevronRight className="ml-auto size-4 text-slate-400" />
        </button>
      </DialogTrigger>
      <DialogContent
        variant="alert"
        aria-describedby={undefined}
        className="flex flex-col overflow-hidden md:max-h-[80dvh] md:max-w-lg md:p-0"
      >
        <DialogHeader className="shrink-0 border-b px-5 py-4 max-md:px-4"><DialogTitle>Select {label.toLowerCase()}</DialogTitle></DialogHeader>
        <div className="flex shrink-0 gap-2 px-5 pt-4 max-md:px-4">
          <div className="relative flex-1"><Search className="pointer-events-none absolute left-3 top-3 size-4 text-slate-400" /><Input autoFocus value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search players" className="pl-9 max-md:h-11" /></div>
          <select value={position} onChange={(event) => setPosition(event.target.value)} className="rounded-md border bg-background px-2 text-sm max-md:h-11 max-md:text-base">
            {POSITIONS.map((item) => <option key={item} value={item}>{item}</option>)}
          </select>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-3 md:max-h-[55vh] md:flex-none">
          {matches.map((player) => (
            <button key={player.id} onClick={() => { onSelect(player); setOpen(false); }} className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left hover:bg-slate-100 dark:hover:bg-slate-800">
              <PlayerAvatar name={player.name} position={player.position} team={player.team} sleeperId={player.sleeper_id} espnId={player.espn_id} size={32} />
              <span className="min-w-0 flex-1"><span className="block truncate font-medium">{player.name}</span><span className="text-xs text-slate-500">{player.team} · {player.position}#{player.position_rank} · overall #{player.rank}</span></span>
              <PositionBadge position={player.position} />
            </button>
          ))}
          {matches.length === 0 && <p className="p-6 text-center text-sm text-slate-500">No matching available players.</p>}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function PlayerMetric({ label, first, second, winnerId, firstPlayer, secondPlayer }: { label: string; first: string | number; second: string | number; winnerId: string | null; firstPlayer: Player; secondPlayer: Player }) {
  return <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3 border-b py-3 text-sm last:border-0 max-md:gap-2"><span className={cn('truncate text-right font-medium', winnerId === firstPlayer.id && 'text-blue-700 dark:text-blue-300')}>{first}</span><span className="min-w-24 text-center text-xs uppercase tracking-wide text-slate-500 max-md:min-w-16">{label}</span><span className={cn('truncate font-medium', winnerId === secondPlayer.id && 'text-blue-700 dark:text-blue-300')}>{second}</span></div>;
}

export interface DraftComparePanelProps {
  selectedIds: [string | null, string | null];
  onSelect: (slot: 0 | 1, player: Player) => void;
  variant?: 'page' | 'modal';
}

export function DraftComparePanel({ selectedIds, onSelect, variant = 'page' }: DraftComparePanelProps) {
  const { data: players = [], isLoading } = useAllPlayers();
  const { data: picks = [] } = useAllDraftPicks();
  const actions = usePlayerActions();
  const isModal = variant === 'modal';

  const selected = useMemo(() => selectedIds.map((id) => players.find((player) => player.id === id)) as [Player | undefined, Player | undefined], [players, selectedIds]);
  const [first, second] = selected;
  const remote = useFantasyProsComparison(selected);
  const local = first && second ? buildLocalDraftComparison([first, second]) : null;
  // Hold the verdict while the FantasyPros query is in flight so the local
  // fallback doesn't flash and then swap out when the expert response lands.
  const awaitingExperts = Boolean(first?.fantasypros_id && second?.fantasypros_id) && remote.isLoading;
  const comparison = awaitingExperts ? null : remote.data?.comparison ?? local;
  const draftedIds = useMemo(() => new Set(picks.map((pick) => pick.player_id)), [picks]);

  const winner = comparison?.winnerId === first?.id ? first : comparison?.winnerId === second?.id ? second : null;
  const winnerScore = winner ? comparison?.scores.find((score) => score.playerId === winner.id)?.score : null;
  const mappingNotice = first && second && (!first.fantasypros_id || !second.fantasypros_id);

  return <div className={cn(isModal ? 'space-y-4' : 'mx-auto max-w-5xl space-y-5')}>
    <Card className="overflow-hidden"><CardContent className="grid gap-3 p-4 md:grid-cols-[1fr_auto_1fr] md:items-center">
      <PlayerPicker label="Player one" selected={first} excludedId={second?.id} players={players} onSelect={(player) => onSelect(0, player)} anchor={second} />
      <ArrowLeftRight className="mx-auto size-5 text-slate-400" />
      <PlayerPicker label="Player two" selected={second} excludedId={first?.id} players={players} onSelect={(player) => onSelect(1, player)} anchor={first} />
    </CardContent></Card>

    {isLoading && <p className="text-center text-sm text-slate-500">Loading player pool…</p>}
    {first && second && awaitingExperts && <Card><CardContent className="p-10 text-center max-md:p-6"><div className="mx-auto grid size-12 place-items-center rounded-full bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300"><Loader2 className="size-6 animate-spin" /></div><h2 className="mt-4 text-lg font-semibold">Checking expert rankings…</h2><p className="mt-2 text-sm text-slate-500">Fetching FantasyPros half-PPR ballots for {first.name} and {second.name}.</p></CardContent></Card>}
    {first && second && comparison && <>
      <Card className="border-blue-200 bg-gradient-to-br from-blue-50 via-white to-indigo-50 dark:border-blue-900 dark:from-blue-950/40 dark:via-slate-950 dark:to-indigo-950/30">
        <CardContent className={cn('grid gap-5 text-center md:grid-cols-3 md:items-center', isModal ? 'p-5' : 'p-6')}>
          <div className="order-2 md:order-1"><p className="text-sm text-slate-500">{first.name}</p><p className="text-4xl font-bold">{comparison.scores[0].score}%</p></div>
          <div className="order-1 md:order-2"><div className="mx-auto grid size-14 place-items-center rounded-full bg-blue-600 text-white"><Trophy className="size-6" /></div><p className="mt-3 text-xs font-semibold uppercase tracking-widest text-blue-700 dark:text-blue-300">{comparison.label}</p><h2 className="mt-1 text-xl font-bold">{winner ? `Draft ${winner.name}` : 'This matchup is a toss-up'}</h2><p className="mt-1 text-sm text-slate-500">{winner && winnerScore != null ? `${winnerScore}% edge` : 'No clear edge'}{comparison.totalExperts ? ` · ${comparison.totalExperts} eligible experts` : ' · based on your current rankings'}</p></div>
          <div className="order-3"><p className="text-sm text-slate-500">{second.name}</p><p className="text-4xl font-bold">{comparison.scores[1].score}%</p></div>
        </CardContent>
      </Card>

      <div className={cn('grid', isModal ? 'gap-4' : 'gap-5 lg:grid-cols-[1.5fr_1fr]')}>
        <Card><CardHeader className="max-md:px-4"><CardTitle>At a glance</CardTitle><CardDescription>Bold values identify the player with the edge in that category.</CardDescription></CardHeader><CardContent className="max-md:px-4">
          <PlayerMetric label="Overall rank" first={`#${first.rank}`} second={`#${second.rank}`} winnerId={first.rank === second.rank ? null : first.rank < second.rank ? first.id : second.id} firstPlayer={first} secondPlayer={second} />
          <PlayerMetric label="Tier" first={first.tier || '—'} second={second.tier || '—'} winnerId={!first.tier || !second.tier || first.tier === second.tier ? null : first.tier < second.tier ? first.id : second.id} firstPlayer={first} secondPlayer={second} />
          <PlayerMetric label="Position" first={`${first.position}${first.position_rank || ''}`} second={`${second.position}${second.position_rank || ''}`} winnerId={first.position === second.position && first.position_rank && second.position_rank && first.position_rank !== second.position_rank ? first.position_rank < second.position_rank ? first.id : second.id : null} firstPlayer={first} secondPlayer={second} />
          <PlayerMetric label="Auction value" first={first.projected_auction_value == null ? '—' : `$${first.projected_auction_value}`} second={second.projected_auction_value == null ? '—' : `$${second.projected_auction_value}`} winnerId={null} firstPlayer={first} secondPlayer={second} />
          <PlayerMetric label="Bye week" first={first.bye_week || '—'} second={second.bye_week || '—'} winnerId={null} firstPlayer={first} secondPlayer={second} />
        </CardContent></Card>
        <div className={cn(isModal ? 'space-y-4' : 'space-y-5')}><Card><CardHeader className="max-md:px-4"><CardTitle>Why</CardTitle></CardHeader><CardContent className="space-y-3 max-md:px-4">{comparison.reasons.length ? comparison.reasons.map((reason) => <div key={reason.label} className="rounded-lg bg-slate-50 p-3 dark:bg-slate-900"><p className="font-medium">{reason.label}</p><p className="mt-1 text-sm text-slate-500">{reason.detail}</p></div>) : <p className="text-sm text-slate-500">Both players are evenly matched by the available data.</p>}</CardContent></Card>
          {winner && <Card><CardContent className="p-4"><p className="mb-3 text-sm font-medium">Ready to add {winner.name}?</p><PlayerActionButton player={winner} isDrafted={draftedIds.has(winner.id)} isPlayerDrafting={actions.isPlayerDrafting(winner.id)} canSnakeDraft={actions.canSnakeDraft} canNominate={actions.canNominate} onAction={actions.handlePlayerAction} size="default" className="w-full" /></CardContent></Card>}
        </div>
      </div>
      {(mappingNotice || remote.data?.unavailable || remote.isError) && <p className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">Using local ranking edge. {mappingNotice ? 'Assign FantasyPros IDs to both players to enable expert ballots.' : remote.data?.unavailable ?? 'FantasyPros is temporarily unavailable.'}</p>}
    </>}
    {!isLoading && (!first || !second) && <Card><CardContent className="p-10 text-center max-md:p-6"><div className="mx-auto grid size-12 place-items-center rounded-full bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300"><Check className="size-6" /></div><h2 className="mt-4 text-lg font-semibold">Pick two players to get started</h2><p className="mt-2 text-sm text-slate-500">The view uses your imported half-PPR rankings now and upgrades to FantasyPros expert ballots as soon as both players have an ID mapping.</p></CardContent></Card>}
  </div>;
}
