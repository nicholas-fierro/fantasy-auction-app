'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Pause, Play, TriangleAlert, Trophy, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useActiveDraft } from '@/contexts/active-draft-context';
import { useMockDraft } from '@/contexts/mock-draft-context';
import { useIsDraftRoom, useNavigation } from '@/contexts/navigation-context';
import { useAllDraftPicks } from '@/hooks/use-draft-picks';
import { useAuctionTeams } from '@/hooks/use-fantasy-teams';
import { useIsMobile } from '@/hooks/use-is-mobile';
import { useIsSnakeLeague, useLeague, useUserTeamId } from '@/hooks/use-league';
import { useOnTheClockState } from '@/hooks/use-on-the-clock-state';
import { getNominatorForPick } from '@/lib/draft-turn';
import { calculateBudgetSummary } from '@/lib/roster';
import { calculateCurrentSnakeTeam, getSnakeRound } from '@/lib/snake-draft';
import { getMockBidState } from '@/lib/mock-draft/bid-state';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { DraftConfirmationModal } from '@/components/draft-confirmation-modal';
import { PlayerAvatar } from '@/components/player-avatar';
import { PlayerNameButton } from '@/components/player-name-button';
import { PositionBadge } from '@/components/position-badge';
import { WinConfetti, markBidPoint } from '@/components/win-confetti';

/* ------------------------------------------------------------------ *
 * Mobile nomination ticker (NFI-57)
 *
 * The phone ticker docks at the bottom of the shell, directly above the tab
 * bar, instead of eating a block under the navbar: a 64px rail carrying every
 * must-see fact on one line, expanding into a sheet with bid entry, player
 * detail, secondary actions and the nomination queue. Rendered as a flex
 * sibling of the scroll area (AppShell) so the players table never hides
 * behind it. Desktop keeps the horizontal LiveTicker in the navbar.
 * ------------------------------------------------------------------ */

interface RailProps {
  expanded: boolean;
  setExpanded: (value: boolean) => void;
}

type Tone = 'default' | 'warn' | 'indigo' | 'muted';

const TONE: Record<Tone, string> = {
  default: 'bg-white border-gray-200 dark:bg-gray-900 dark:border-gray-700',
  warn: 'bg-amber-50 border-amber-400 dark:bg-amber-950/40 dark:border-amber-700',
  indigo: 'bg-indigo-50 border-indigo-200 dark:bg-indigo-950/40 dark:border-indigo-800',
  muted: 'bg-slate-50 border-gray-200 dark:bg-gray-900 dark:border-gray-700',
};

interface FrameProps {
  tone?: Tone;
  expanded: boolean;
  setExpanded: (value: boolean) => void;
  rail: ReactNode;
  /** Omitted for states with nothing more to show — the rail then can't expand. */
  sheet?: ReactNode;
  /** Swiping the collapsed rail sideways passes, per the handoff. */
  onSwipeAway?: () => void;
}

// Distance a pointer has to travel before a drag counts as a gesture rather
// than a tap on whatever control it started over.
const DRAG_THRESHOLD = 40;

function TickerFrame({
  tone = 'default',
  expanded,
  setExpanded,
  rail,
  sheet,
  onSwipeAway,
}: FrameProps) {
  const expandable = !!sheet;
  const open = expanded && expandable;
  const onToggle = () => setExpanded(!expanded);

  // Leaving an expandable state (passing, clearing, a pick committing) has to
  // drop the flag too: otherwise the next nomination reopens the sheet — and on
  // a live draft refocuses the bid field — without the user asking for it.
  useEffect(() => {
    if (!expandable && expanded) setExpanded(false);
  }, [expandable, expanded, setExpanded]);

  // Pointer capture is claimed only once the movement passes the threshold: a
  // tap never captures, so taps still reach the buttons under the pointer, and
  // a recognised drag is guaranteed its `pointerup`/`pointercancel` even after
  // the pointer has left the rail. `touch-none` on the panel keeps the browser
  // from stealing the vertical drag as a scroll.
  const drag = useRef<{ x: number; y: number; captured: boolean } | null>(null);

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    drag.current = { x: event.clientX, y: event.clientY, captured: false };
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const from = drag.current;
    if (!from || from.captured) return;
    if (
      Math.abs(event.clientX - from.x) < DRAG_THRESHOLD &&
      Math.abs(event.clientY - from.y) < DRAG_THRESHOLD
    ) {
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    from.captured = true;
  };

  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    const from = drag.current;
    drag.current = null;
    if (!from?.captured) return; // a tap — leave it to the click handlers
    event.currentTarget.releasePointerCapture(event.pointerId);
    const dx = event.clientX - from.x;
    const dy = event.clientY - from.y;
    // Horizontal swipe on the collapsed rail = pass; vertical = open / close.
    if (Math.abs(dx) > Math.abs(dy)) {
      if (!open) onSwipeAway?.();
      return;
    }
    if (dy < 0) {
      if (expandable) setExpanded(true);
    } else {
      setExpanded(false);
    }
  };

  const onPointerCancel = () => {
    drag.current = null;
  };

  return (
    <>
      {open && (
        // Sits below the navbar and tab bar in the stack (both z-50), so it
        // dims only the content region and navigation stays usable.
        <button
          type="button"
          aria-label="Collapse draft controls"
          onClick={onToggle}
          className="fixed inset-0 z-30 bg-slate-900/20 motion-safe:animate-in motion-safe:fade-in"
        />
      )}
      {/* Only the 64px rail reserves layout space — the sheet grows upward out
          of this box and overlays the players table instead of shrinking it. */}
      <div className="relative z-40 h-16 shrink-0">
        <div
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerCancel}
          className={cn(
            'absolute inset-x-0 bottom-0 touch-none border-t transition-[border-radius] duration-200 motion-reduce:transition-none',
            TONE[tone],
            open
              ? 'rounded-t-[18px] shadow-[0_-14px_40px_rgba(15,23,42,0.18)] motion-safe:animate-in motion-safe:slide-in-from-bottom-4'
              : 'shadow-[0_-10px_28px_rgba(15,23,42,0.1)]'
          )}
        >
          {expandable && (
            // The handle carries the drag affordance; it doubles as a tap
            // target so the sheet can be collapsed from its own header.
            <button
              type="button"
              onClick={onToggle}
              aria-expanded={open}
              aria-label={open ? 'Collapse draft controls' : 'Expand draft controls'}
              className="absolute inset-x-0 top-0 z-10 flex h-3.5 justify-center pt-[5px]"
            >
              <span className="h-1 w-9 rounded-full bg-slate-300 dark:bg-gray-600" />
            </button>
          )}
          {open ? (
            <div className="flex flex-col gap-3 px-3 pb-3.5 pt-3">{sheet}</div>
          ) : (
            <div className="flex h-16 items-center gap-2.5 pl-3.5 pr-2.5">{rail}</div>
          )}
        </div>
      </div>
    </>
  );
}

/** The rail's two-line content column; tapping it opens the sheet. */
function RailInfo({
  onToggle,
  expandable,
  children,
}: {
  onToggle: () => void;
  expandable: boolean;
  children: ReactNode;
}) {
  const className = 'flex min-w-0 flex-1 flex-col gap-[3px] text-left';
  if (!expandable) return <div className={className}>{children}</div>;
  return (
    <button type="button" onClick={onToggle} className={className}>
      {children}
    </button>
  );
}

function PlayerLine({
  name,
  position,
  meta,
}: {
  name: string;
  position: string;
  meta?: ReactNode;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="min-w-0 truncate text-sm font-extrabold text-gray-900 dark:text-white">
        {name}
      </span>
      <PositionBadge position={position} className="shrink-0 px-1 py-0 text-[9px] font-extrabold" />
      {meta && <span className="shrink-0 text-[9.5px] text-gray-400">{meta}</span>}
    </div>
  );
}

function MaxSuffix({ value }: { value: number }) {
  return <span className="shrink-0 text-[10px] tabular-nums text-gray-400"> · max ${value}</span>;
}

/** Design's "Nominating 4 Garrett → 5 Danny" queue line for the expanded sheet. */
function QueueLine() {
  const { data: draftPicks = [] } = useAllDraftPicks();
  const { data: teams = [] } = useAuctionTeams();
  const { settings } = useLeague();

  const teamById = new Map(teams.map((team) => [team.id, team]));
  const nominator = teamById.get(
    getNominatorForPick(draftPicks.length, draftPicks, teams, settings.paidAuctionSlots) ?? ''
  );
  const next = teamById.get(
    getNominatorForPick(draftPicks.length + 1, draftPicks, teams, settings.paidAuctionSlots) ?? ''
  );
  if (!nominator && !next) return null;

  return (
    <div className="flex items-center gap-[7px] text-[10px] text-gray-400">
      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" />
      <span className="truncate">
        Nominating {nominator ? `${nominator.draft_order} ${nominator.name}` : '—'}
        {next && ` → ${next.draft_order} ${next.name}`}
      </span>
    </div>
  );
}

const PRIMARY_BUTTON =
  'h-12 shrink-0 rounded-[11px] bg-green-700 px-[18px] text-base font-extrabold text-white hover:bg-green-700 active:bg-green-800';
const SHEET_PRIMARY =
  'h-[46px] shrink-0 rounded-[11px] bg-green-700 px-4 text-[15px] font-extrabold text-white hover:bg-green-700 active:bg-green-800';
const SECONDARY_BUTTON =
  'h-11 rounded-[10px] border-gray-300 bg-white text-sm font-bold text-slate-700 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200';

function PassIconButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="flex h-11 w-[34px] shrink-0 items-center justify-center rounded-[9px] border border-gray-300 bg-white text-gray-500 active:bg-gray-100 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300"
    >
      <X className="h-4 w-4" />
    </button>
  );
}

/* ------------------------------------------------------------------ *
 * Live auction
 * ------------------------------------------------------------------ */

function AuctionRail({ expanded, setExpanded }: RailProps) {
  const onToggle = () => setExpanded(!expanded);
  const { activePlayer, canClearActivePlayer, setActivePlayer } = useActiveDraft();
  const { onTheClock } = useOnTheClockState();
  const { data: draftPicks = [] } = useAllDraftPicks();
  const { data: teams = [] } = useAuctionTeams();
  const userTeamId = useUserTeamId();
  const { settings } = useLeague();
  const [bid, setBid] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false);

  useEffect(() => {
    setBid('');
  }, [activePlayer?.id]);

  const { maxBid } = calculateBudgetSummary(
    draftPicks.filter((pick) => pick.fantasy_team_id === userTeamId),
    settings
  );
  if (!activePlayer) {
    // View D — your turn to nominate.
    if (onTheClock) {
      return (
        <TickerFrame
          tone="warn"
          expanded={expanded}
          setExpanded={setExpanded}
          rail={
            <>
              <span className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-full bg-amber-200 text-[13px] font-extrabold text-amber-800 dark:bg-amber-900 dark:text-amber-300">
                !
              </span>
              <RailInfo onToggle={onToggle} expandable={false}>
                <span className="text-[13.5px] font-extrabold text-gray-900 dark:text-white">
                  Your nomination
                </span>
                <span className="text-[10.5px] tabular-nums text-amber-800 dark:text-amber-300">
                  Tap any player · max ${maxBid}
                </span>
              </RailInfo>
            </>
          }
        />
      );
    }

    // View G — idle.
    const nominatorId = getNominatorForPick(
      draftPicks.length,
      draftPicks,
      teams,
      settings.paidAuctionSlots
    );
    const nominator = teams.find((team) => team.id === nominatorId);
    return (
      <TickerFrame
        expanded={expanded}
        setExpanded={setExpanded}
        rail={
          <>
            <span className="h-[7px] w-[7px] shrink-0 rounded-full bg-emerald-500" />
            <span className="min-w-0 flex-1 truncate text-[13px] text-slate-500 dark:text-gray-400">
              {nominator ? `Waiting on ${nominator.name} to nominate…` : 'No player nominated'}
            </span>
            <span className="shrink-0 text-[10px] font-extrabold tabular-nums text-gray-400">
              ${maxBid} MAX
            </span>
          </>
        }
      />
    );
  }

  const submit = () => {
    if (bid.trim()) setConfirmOpen(true);
  };
  const clear = () => setActivePlayer(null);

  return (
    <>
      <TickerFrame
        expanded={expanded}
        setExpanded={setExpanded}
        onSwipeAway={canClearActivePlayer ? clear : undefined}
        rail={
          <>
            <RailInfo onToggle={onToggle} expandable>
              <PlayerLine
                name={activePlayer.name}
                position={activePlayer.position}
                meta={`T${activePlayer.tier} · ${activePlayer.position}${activePlayer.position_rank}`}
              />
              <div className="flex items-center gap-1.5">
                {activePlayer.projected_auction_value != null && (
                  <span className="text-[15px] font-extrabold tabular-nums text-gray-900 dark:text-white">
                    ${activePlayer.projected_auction_value}
                  </span>
                )}
                <MaxSuffix value={maxBid} />
              </div>
            </RailInfo>
            {canClearActivePlayer && <PassIconButton onClick={clear} label="Remove nomination" />}
            <Button className={PRIMARY_BUTTON} onClick={onToggle}>
              Draft
            </Button>
          </>
        }
        sheet={
          <>
            <div className="flex items-center gap-2.5">
              <PlayerAvatar
                name={activePlayer.name}
                position={activePlayer.position}
                team={activePlayer.team}
                sleeperId={activePlayer.sleeper_id}
                espnId={activePlayer.espn_id}
                size={38}
              />
              <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
                <div className="flex items-center gap-1.5">
                  <PlayerNameButton player={activePlayer} className="truncate text-base font-extrabold" />
                  <PositionBadge
                    position={activePlayer.position}
                    className="shrink-0 px-1 py-0 text-[9px] font-extrabold"
                  />
                </div>
                <span className="truncate text-[10.5px] tabular-nums text-slate-500 dark:text-gray-400">
                  Ovr {activePlayer.rank} · {activePlayer.position}
                  {activePlayer.position_rank} · Tier {activePlayer.tier} · {activePlayer.team} · BYE{' '}
                  {activePlayer.bye_week}
                </span>
              </div>
              <div className="flex shrink-0 flex-col items-end">
                <span className="text-xl font-extrabold leading-[1.1] tabular-nums text-gray-900 dark:text-white">
                  ${activePlayer.projected_auction_value ?? '—'}
                </span>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <div className="flex h-[46px] min-w-0 flex-1 items-center gap-2 rounded-[11px] border border-gray-300 bg-slate-50 px-3 dark:border-gray-600 dark:bg-gray-800">
                <span className="text-[15px] font-extrabold text-gray-400">$</span>
                <Input
                  type="number"
                  inputMode="numeric"
                  autoFocus
                  placeholder="0"
                  value={bid}
                  onChange={(event) => setBid(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') submit();
                  }}
                  // 16px keeps iOS Safari from zooming the page on focus.
                  className="h-auto min-w-0 flex-1 border-0 bg-transparent px-0 text-[16px] font-extrabold tabular-nums shadow-none focus-visible:ring-0"
                  min="0"
                  step="1"
                />
                <span className="shrink-0 text-[10px] font-bold tabular-nums text-gray-400">
                  MAX {maxBid}
                </span>
              </div>
              <Button className={SHEET_PRIMARY} onClick={submit} disabled={!bid.trim()}>
                Draft
              </Button>
            </div>

            {canClearActivePlayer && (
              <Button variant="outline" className={cn(SECONDARY_BUTTON, 'w-full')} onClick={clear}>
                Pass
              </Button>
            )}

            <QueueLine />
          </>
        }
      />
      <DraftConfirmationModal
        isOpen={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        player={activePlayer}
        initialValue={bid}
        onSuccess={() => {
          setBid('');
          setActivePlayer(null);
          setConfirmOpen(false);
          setExpanded(false);
        }}
      />
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Live snake round (View E, without the sim-only Advance)
 * ------------------------------------------------------------------ */

function SnakeRail({ expanded, setExpanded }: RailProps) {
  const onToggle = () => setExpanded(!expanded);
  const { data: teams = [] } = useAuctionTeams();
  const { data: draftPicks = [] } = useAllDraftPicks();
  const { settings } = useLeague();

  const { currentTeam, nextTeam } = calculateCurrentSnakeTeam(
    teams,
    draftPicks.length,
    settings.paidAuctionSlots
  );
  const pickNumber = draftPicks.length + 1;

  if (!currentTeam) {
    return (
      <TickerFrame
        tone="muted"
        expanded={expanded}
        setExpanded={setExpanded}
        rail={
          <span className="text-[13px] text-slate-500 dark:text-gray-400">
            Auction phase in progress
          </span>
        }
      />
    );
  }

  return (
    <TickerFrame
      tone="indigo"
      expanded={expanded}
      setExpanded={setExpanded}
      rail={
        <>
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-indigo-200 text-[11.5px] font-extrabold text-indigo-800 dark:bg-indigo-900 dark:text-indigo-300">
            {currentTeam.draft_order}
          </span>
          <RailInfo onToggle={onToggle} expandable={false}>
            <span className="truncate text-[13.5px] font-extrabold text-gray-900 dark:text-white">
              {currentTeam.name} on the clock
            </span>
            <span className="truncate text-[10.5px] tabular-nums text-indigo-700 dark:text-indigo-300">
              Snake R{getSnakeRound(pickNumber, teams.length, settings.paidAuctionSlots)} · pick #{pickNumber}
              {nextTeam && ` · next ${nextTeam.name}`}
            </span>
          </RailInfo>
        </>
      }
    />
  );
}

/* ------------------------------------------------------------------ *
 * Simulated mock draft
 * ------------------------------------------------------------------ */

function SimRail({ expanded, setExpanded }: RailProps) {
  const onToggle = () => setExpanded(!expanded);
  // Snake rounds depend on the league's own size and paid-slot count, not the
  // 12/7 defaults.
  const { data: teams = [] } = useAuctionTeams();
  const { settings } = useLeague();
  const {
    isActive,
    disabledReason,
    status,
    phase,
    currentTeam,
    nextPickOrder,
    pending,
    userMaxBid,
    paused,
    autoAdvance,
    pass,
    counter,
    stepSnake,
    setPaused,
    setAutoAdvance,
  } = useMockDraft();
  const [bidDraft, setBidDraft] = useState('');

  // A new nomination — or collapsing the sheet — resets the keypad: a value the
  // user can no longer see must not stay armed.
  const pendingPlayerId = pending?.player.id ?? null;
  useEffect(() => {
    setBidDraft('');
  }, [pendingPlayerId, expanded]);

  const pauseButton = (
    <Button
      variant="outline"
      className={cn(SECONDARY_BUTTON, 'flex-1 gap-2')}
      onClick={() => setPaused(!paused)}
    >
      {paused ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}
      {paused ? 'Resume sim' : 'Pause sim'}
    </Button>
  );

  if (disabledReason) {
    return (
      <TickerFrame
        tone="warn"
        expanded={expanded}
        setExpanded={setExpanded}
        rail={
          <span className="flex min-w-0 items-center gap-2 text-[13px] text-amber-900 dark:text-amber-300">
            <TriangleAlert className="h-4 w-4 shrink-0" />
            <span className="truncate">{disabledReason}</span>
          </span>
        }
      />
    );
  }

  if (!isActive) {
    return (
      <TickerFrame
        tone="muted"
        expanded={expanded}
        setExpanded={setExpanded}
        rail={
          <span className="text-[13px] text-slate-500 dark:text-gray-400">
            Simulation not running
          </span>
        }
      />
    );
  }

  if (status === 'complete') {
    return (
      <TickerFrame
        tone="muted"
        expanded={expanded}
        setExpanded={setExpanded}
        rail={
          <>
            <Trophy className="h-5 w-5 shrink-0 text-amber-500" />
            <span className="min-w-0 flex-1 truncate text-[13px] font-bold text-gray-900 dark:text-white">
              Mock draft complete — review the board
            </span>
          </>
        }
      />
    );
  }

  // View F — paused.
  if (paused) {
    return (
      <TickerFrame
        tone="muted"
        expanded={expanded}
        setExpanded={setExpanded}
        rail={
          <>
            <span className="min-w-0 flex-1 truncate text-[13px] text-slate-500 dark:text-gray-400">
              Paused · {currentTeam?.name ?? 'the next team'} nominates next
            </span>
            <Button
              className="h-11 shrink-0 rounded-[10px] bg-slate-900 px-4 text-[13.5px] font-bold text-white hover:bg-slate-900 active:bg-slate-800 dark:bg-slate-100 dark:text-slate-900"
              onClick={() => setPaused(false)}
            >
              Resume
            </Button>
          </>
        }
      />
    );
  }

  // View E — snake round.
  if (phase === 'snake') {
    const round = getSnakeRound(nextPickOrder, teams.length, settings.paidAuctionSlots);
    const yours = status === 'snake-user';
    return (
      <TickerFrame
        tone="indigo"
        expanded={expanded}
        setExpanded={setExpanded}
        rail={
          <>
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-indigo-200 text-[11.5px] font-extrabold text-indigo-800 dark:bg-indigo-900 dark:text-indigo-300">
              {round}
            </span>
            <RailInfo onToggle={onToggle} expandable>
              <span className="truncate text-[13.5px] font-extrabold text-gray-900 dark:text-white">
                {yours ? 'Your pick' : `${currentTeam?.name ?? 'A team'} on the clock`}
              </span>
              <span className="truncate text-[10.5px] tabular-nums text-indigo-700 dark:text-indigo-300">
                Snake R{round} · pick #{nextPickOrder}
                {yours && ' · tap any player'}
              </span>
            </RailInfo>
            {status === 'snake-ai' && !autoAdvance && (
              <Button
                variant="outline"
                className="h-11 shrink-0 rounded-[10px] border-indigo-200 bg-white px-3.5 text-[13px] font-bold text-indigo-800 dark:border-indigo-800 dark:bg-gray-900 dark:text-indigo-300"
                onClick={stepSnake}
              >
                Advance
              </Button>
            )}
          </>
        }
        sheet={
          <>
            <div className="flex flex-col gap-1">
              <span className="text-[9px] font-extrabold tracking-[0.06em] text-indigo-600 dark:text-indigo-400">
                SNAKE · ROUND {round}
              </span>
              <span className="text-sm font-extrabold text-gray-900 dark:text-white">
                {yours
                  ? `Your pick (#${nextPickOrder}) — pick a player from the table`
                  : `${currentTeam?.name ?? 'A team'} is picking…`}
              </span>
            </div>
            {status === 'snake-ai' && (
              <label className="flex min-h-11 items-center gap-2 text-xs text-slate-600 dark:text-gray-300">
                <input
                  type="checkbox"
                  className="size-5"
                  checked={autoAdvance}
                  onChange={(event) => setAutoAdvance(event.target.checked)}
                />
                Auto-advance
              </label>
            )}
            <div className="flex gap-2">
              {status === 'snake-ai' && !autoAdvance && (
                <Button variant="outline" className={cn(SECONDARY_BUTTON, 'flex-1')} onClick={stepSnake}>
                  Advance one pick
                </Button>
              )}
              {pauseButton}
            </div>
          </>
        }
      />
    );
  }

  // View D — your turn to nominate.
  if (status === 'user-nominate') {
    return (
      <TickerFrame
        tone="warn"
        expanded={expanded}
        setExpanded={setExpanded}
        rail={
          <>
            <span className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-full bg-amber-200 text-[13px] font-extrabold text-amber-800 dark:bg-amber-900 dark:text-amber-300">
              !
            </span>
            <RailInfo onToggle={onToggle} expandable>
              <span className="text-[13.5px] font-extrabold text-gray-900 dark:text-white">
                Your nomination
              </span>
              <span className="text-[10.5px] tabular-nums text-amber-800 dark:text-amber-300">
                Tap any player · max ${userMaxBid}
              </span>
            </RailInfo>
            <Button
              variant="outline"
              className="h-11 shrink-0 rounded-[10px] border-gray-300 bg-white px-3.5 text-[13px] font-bold text-slate-700 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200"
              onClick={() => setPaused(true)}
            >
              Pause
            </Button>
          </>
        }
        sheet={
          <>
            <div className="flex flex-col gap-1">
              <span className="text-[9px] font-extrabold tracking-[0.06em] text-amber-700 dark:text-amber-400">
                YOUR NOMINATION
              </span>
              <span className="text-[13px] text-slate-600 dark:text-gray-300">
                Pick a player from the table · max ${userMaxBid}
              </span>
            </div>
            <div className="flex gap-2">{pauseButton}</div>
            <QueueLine />
          </>
        }
      />
    );
  }

  // Views A / C — a nomination is on the table.
  if (pending) {
    const { minBid, canCounter } = getMockBidState(pending, userMaxBid);
    // The keypad amount, when the user typed one — otherwise the next legal
    // increment. Anything illegal keeps the Bid button disabled rather than
    // being clamped into a bid the user never entered.
    const typed = bidDraft.trim() === '' ? null : Number(bidDraft);
    const amount = typed ?? minBid;
    const legalAmount =
      Number.isInteger(amount) && amount >= minBid && amount <= userMaxBid;
    // Each button carries the amount it advertises — the rail's "Bid $N" must
    // never spend a keypad value typed in a sheet that is no longer on screen.
    const placeBid = (bidAmount: number) => (event: React.MouseEvent<HTMLButtonElement>) => {
      markBidPoint(event.currentTarget);
      counter(bidAmount);
      setBidDraft('');
    };
    const meta = `T${pending.player.tier} · ${pending.player.position}${pending.player.position_rank}`;

    return (
      <TickerFrame
        expanded={expanded}
        setExpanded={setExpanded}
        onSwipeAway={pending.uncontested ? undefined : pass}
        rail={
          <>
            <RailInfo onToggle={onToggle} expandable>
              <PlayerLine
                name={pending.player.name}
                position={pending.player.position}
                meta={meta}
              />
              {pending.uncontested ? (
                <span className="text-[10px] font-bold tabular-nums text-green-800 dark:text-green-400">
                  No AI interest · yours at ${pending.price}
                </span>
              ) : (
                <div className="flex items-center gap-1.5">
                  <span className="text-[15px] font-extrabold tabular-nums text-gray-900 dark:text-white">
                    ${pending.price}
                  </span>
                  <span className="min-w-0 truncate text-[10px] font-bold text-amber-800 dark:text-amber-400">
                    {pending.winnerTeam?.name ?? 'A team'} leads
                  </span>
                  <MaxSuffix value={userMaxBid} />
                </div>
              )}
            </RailInfo>
            {pending.uncontested ? (
              <Button className={PRIMARY_BUTTON} onClick={placeBid(minBid)}>
                Draft ${pending.price}
              </Button>
            ) : (
              <>
                <PassIconButton onClick={pass} label="Pass on this player" />
                <Button
                  className={PRIMARY_BUTTON}
                  onClick={placeBid(minBid)}
                  disabled={!canCounter}
                  title={!canCounter ? 'Not enough budget to counter' : undefined}
                >
                  Bid ${minBid}
                </Button>
              </>
            )}
          </>
        }
        sheet={
          <>
            <span className="text-[9px] font-extrabold tracking-[0.06em] text-blue-600 dark:text-blue-400">
              {pending.reason === 'user'
                ? 'YOUR NOMINATION'
                : `${pending.nominatorTeam?.name ?? 'A team'} NOMINATES${pending.reason === 'drain' ? ' (BUDGET DRAIN)' : ''}`}
            </span>
            <div className="flex items-center gap-2.5">
              <PlayerAvatar
                name={pending.player.name}
                position={pending.player.position}
                team={pending.player.team}
                sleeperId={pending.player.sleeper_id}
                espnId={pending.player.espn_id}
                size={38}
              />
              <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
                <div className="flex items-center gap-1.5">
                  <PlayerNameButton
                    player={pending.player}
                    className="truncate text-base font-extrabold"
                  />
                  <PositionBadge
                    position={pending.player.position}
                    className="shrink-0 px-1 py-0 text-[9px] font-extrabold"
                  />
                </div>
                <span className="truncate text-[10.5px] tabular-nums text-slate-500 dark:text-gray-400">
                  Ovr {pending.player.rank} · {pending.player.position}
                  {pending.player.position_rank} · Tier {pending.player.tier} · {pending.player.team} ·
                  BYE {pending.player.bye_week}
                </span>
              </div>
              <div className="flex shrink-0 flex-col items-end">
                <span className="text-xl font-extrabold leading-[1.1] tabular-nums text-gray-900 dark:text-white">
                  ${pending.price}
                </span>
                <span className="rounded-[5px] bg-amber-100 px-1.5 py-px text-[9.5px] font-bold text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">
                  {pending.uncontested ? 'no AI interest' : `${pending.winnerTeam?.name ?? 'A team'} leads`}
                </span>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <div className="flex h-[46px] min-w-0 flex-1 items-center gap-2 rounded-[11px] border border-gray-300 bg-slate-50 px-3 dark:border-gray-600 dark:bg-gray-800">
                <span className="text-[15px] font-extrabold text-gray-400">$</span>
                <Input
                  type="number"
                  inputMode="numeric"
                  placeholder={String(minBid)}
                  value={bidDraft}
                  onChange={(event) => setBidDraft(event.target.value)}
                  aria-label="Bid amount"
                  // 16px keeps iOS Safari from zooming the page on focus.
                  className="h-auto min-w-0 flex-1 border-0 bg-transparent px-0 text-[16px] font-extrabold tabular-nums shadow-none focus-visible:ring-0"
                  min={minBid}
                  max={userMaxBid}
                  step="1"
                />
                <span className="shrink-0 text-[10px] font-bold tabular-nums text-gray-400">
                  MAX {userMaxBid}
                </span>
              </div>
              <Button
                className={SHEET_PRIMARY}
                onClick={placeBid(amount)}
                disabled={!legalAmount}
                title={!legalAmount ? `Enter $${minBid}–$${userMaxBid}` : undefined}
              >
                {pending.uncontested ? 'Draft' : 'Bid'}
              </Button>
            </div>

            <div className="flex gap-2">
              {!pending.uncontested && (
                <Button variant="outline" className={cn(SECONDARY_BUTTON, 'flex-1')} onClick={pass}>
                  Pass
                </Button>
              )}
              {pauseButton}
            </div>

            <QueueLine />
          </>
        }
      />
    );
  }

  // Transient — an AI team is about to nominate.
  return (
    <TickerFrame
      expanded={expanded}
      setExpanded={setExpanded}
      rail={
        <>
          <span className="h-[7px] w-[7px] shrink-0 rounded-full bg-emerald-500" />
          <span className="min-w-0 flex-1 truncate text-[13px] text-slate-500 dark:text-gray-400">
            {currentTeam?.name ?? 'A team'} is nominating…
          </span>
          <span className="shrink-0 text-[10px] font-extrabold tabular-nums text-gray-400">
            ${userMaxBid} MAX
          </span>
        </>
      }
    />
  );
}

export function MobileNominationTicker() {
  const { isSnakeMode } = useNavigation();
  const isSnakeLeague = useIsSnakeLeague();
  const { simFlagged } = useMockDraft();
  const isDraftRoom = useIsDraftRoom();
  const isMobile = useIsMobile();
  const [expanded, setExpanded] = useState(false);

  // Historical and landing/history surfaces are view-only — no live ticker.
  if (!isDraftRoom || !isMobile) return null;

  if (simFlagged) {
    return (
      <>
        <SimRail expanded={expanded} setExpanded={setExpanded} />
        <WinConfetti />
      </>
    );
  }
  if (isSnakeLeague || isSnakeMode) return <SnakeRail expanded={expanded} setExpanded={setExpanded} />;
  return <AuctionRail expanded={expanded} setExpanded={setExpanded} />;
}
