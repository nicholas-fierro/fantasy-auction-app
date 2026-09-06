'use client';

import { useEffect, useState, type ComponentType } from 'react';
import {
  Users,
  Trophy,
  Layout,
  Eye,
  LogOut,
  LineChart,
  Settings,
  DollarSign,
  Check,
  X,
  ArrowRight,
  ArrowLeft,
  ArrowLeftRight,
  Pause,
  Play,
  TriangleAlert,
  Flag,
  Bell,
  Clock3,
  BellOff,
  Ellipsis,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useIsDraftRoom, useNavigation, type ViewType } from '@/contexts/navigation-context';
import { useAuction } from '@/contexts/auction-context';
import { useLeagueContext } from '@/contexts/league-context';
import { useActiveDraft } from '@/contexts/active-draft-context';
import { useMockDraft } from '@/contexts/mock-draft-context';
import { useAuctionTeams } from '@/hooks/use-fantasy-teams';
import { useAllDraftPicks } from '@/hooks/use-draft-picks';
import { useLeague, useUserTeamId } from '@/hooks/use-league';
import { useCompleteAuction, useDeleteAuction } from '@/hooks/use-auctions';
import { useIsMobile } from '@/hooks/use-is-mobile';
import { useOnTheClockState } from '@/hooks/use-on-the-clock-state';
import { useNotificationPreferences } from '@/contexts/notification-preferences-context';
import { calculateBudgetSummary } from '@/lib/roster';
import { calculateCurrentSnakeTeam, getTeamPickCount, getSnakeRound } from '@/lib/snake-draft';
import { getNominatorForPick } from '@/lib/draft-turn';
import { signOut } from '@/lib/session';
import { pb } from '@/lib/pb-client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { WatchlistSidebar } from '@/components/watchlist-sidebar';
import { PositionBadge } from '@/components/position-badge';
import { PlayerAvatar } from '@/components/player-avatar';
import { PlayerNameButton } from '@/components/player-name-button';
import { DraftConfirmationModal } from '@/components/draft-confirmation-modal';
import { WinConfetti } from '@/components/win-confetti';
import { MockBidActions } from '@/components/mock-bid-actions';
import type { FantasyTeam } from '@/server/types/fantasy-team';

// Shared with MobileTabBar (the phone-width bottom bar) so the two navs can't drift.
export const navigationItems = [
  { id: 'players' as ViewType, label: 'Players', icon: Users },
  { id: 'draft-board' as ViewType, label: 'Draft Board', icon: Layout },
  { id: 'fantasy-teams' as ViewType, label: 'Teams', icon: Trophy },
  { id: 'analysis' as ViewType, label: 'Analysis', icon: LineChart },
];

type HeaderAction = {
  id: 'end-draft' | 'leave-draft-room' | 'switch-league' | 'settings';
  icon: ComponentType<{ className?: string }>;
  label: string;
  onSelect: () => void;
  destructive?: boolean;
};

function useHeaderActions(onEndDraft: () => void) {
  const {
    setCurrentView,
    setLandingOverride,
    landingStage,
    returnToLeagueLanding,
  } = useNavigation();
  const { selectedAuction } = useAuction();
  const { memberships } = useLeagueContext();
  const showLiveNavigation = useIsDraftRoom();
  const isOwnActiveDraft =
    showLiveNavigation &&
    selectedAuction?.status === 'active' &&
    selectedAuction.user === pb.authStore.record?.id;

  const actions: HeaderAction[] = [];

  if (landingStage !== 'league') {
    actions.push({
      id: 'switch-league',
      icon: ArrowLeftRight,
      label: memberships.length > 1 ? 'Switch League' : 'Manage Leagues',
      onSelect: returnToLeagueLanding,
    });
  }

  actions.push({
    id: 'settings',
    icon: Settings,
    label: 'Settings',
    onSelect: () => setCurrentView('settings'),
  });

  if (showLiveNavigation) {
    actions.push({
      id: 'leave-draft-room',
      icon: ArrowLeft,
      label: 'Leave Draft Room',
      // Leaving is a view change, not a lifecycle one: the draft stays selected
      // and a mock sim keeps resolving AI-only picks in the background.
      onSelect: () => {
        setLandingOverride(true);
        setCurrentView('players');
      },
    });
  }

  if (isOwnActiveDraft) {
    actions.push({
      id: 'end-draft',
      icon: Flag,
      label: 'End Draft',
      onSelect: onEndDraft,
      destructive: true,
    });
  }

  return { actions, showLiveNavigation, isOwnActiveDraft };
}

function EndDraftDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { selectedAuction } = useAuction();
  const { returnToDashboard } = useNavigation();
  const completeAuction = useCompleteAuction();
  const deleteAuction = useDeleteAuction();
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const closeDialog = (nextOpen: boolean) => {
    onOpenChange(nextOpen);
    if (!nextOpen) {
      setConfirmingDelete(false);
      completeAuction.reset();
      deleteAuction.reset();
    }
  };

  // Surfaced in the dialog — a rejected lifecycle call must not just vanish
  // into the console with the dialog sitting there looking idle.
  const actionError = deleteAuction.error ?? completeAuction.error;

  const handleComplete = async () => {
    if (!selectedAuction) return;
    try {
      await completeAuction.mutateAsync(selectedAuction.id);
      closeDialog(false);
    } catch (error) {
      console.error('Failed to complete auction:', error);
    }
  };

  const handleDelete = async () => {
    if (!selectedAuction) return;
    try {
      await deleteAuction.mutateAsync(selectedAuction.id);
      closeDialog(false);
      returnToDashboard();
    } catch (error) {
      console.error('Failed to delete auction:', error);
    }
  };

  return (
    <Dialog open={open && Boolean(selectedAuction)} onOpenChange={closeDialog}>
      {selectedAuction && (
        <DialogContent variant="alert" className="max-w-md">
          {confirmingDelete ? (
            <>
              <DialogHeader>
                <DialogTitle>Delete Draft</DialogTitle>
                <DialogDescription>
                  {`"${selectedAuction.name}" and all its picks will be permanently deleted. This cannot be undone.`}
                </DialogDescription>
              </DialogHeader>
              {actionError && (
                <p className="text-sm font-medium text-red-600 dark:text-red-400">
                  {actionError.message}
                </p>
              )}
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => {
                    setConfirmingDelete(false);
                    deleteAuction.reset();
                  }}
                  disabled={deleteAuction.isPending}
                >
                  Cancel
                </Button>
                <Button
                  variant="destructive"
                  onClick={handleDelete}
                  disabled={deleteAuction.isPending}
                  className="min-w-24"
                >
                  {deleteAuction.isPending ? 'Deleting...' : 'Delete'}
                </Button>
              </DialogFooter>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>End Draft</DialogTitle>
                <DialogDescription>
                  {`"${selectedAuction.name}" can be ended early. Completing it saves the draft to Draft History with the picks made so far. Deleting it discards the draft and all its picks permanently.`}
                </DialogDescription>
              </DialogHeader>
              {actionError && (
                <p className="text-sm font-medium text-red-600 dark:text-red-400">
                  {actionError.message}
                </p>
              )}
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => closeDialog(false)}
                  disabled={completeAuction.isPending}
                >
                  Cancel
                </Button>
                <Button
                  variant="destructive"
                  onClick={() => setConfirmingDelete(true)}
                  disabled={completeAuction.isPending}
                  className="min-w-24"
                >
                  Delete draft
                </Button>
                <Button
                  onClick={handleComplete}
                  disabled={completeAuction.isPending}
                  className="min-w-32"
                >
                  {completeAuction.isPending ? 'Saving...' : 'Complete & save'}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      )}
    </Dialog>
  );
}

function TierOneBar() {
  const {
    currentView,
    setCurrentView,
    setLandingOverride,
    showWatchlist,
    setShowWatchlist,
  } = useNavigation();
  const { setSelectedAuctionId } = useAuction();
  const [endDraftOpen, setEndDraftOpen] = useState(false);
  const { actions, showLiveNavigation, isOwnActiveDraft } = useHeaderActions(() => setEndDraftOpen(true));

  useEffect(() => {
    if (!isOwnActiveDraft) setEndDraftOpen(false);
  }, [isOwnActiveDraft]);

  const goHome = () => {
    if (!showLiveNavigation) setSelectedAuctionId(null);
    setLandingOverride(!showLiveNavigation);
    setCurrentView('players');
  };

  // The horizontal scroll is md-and-up only: it exists so the desktop action
  // cluster can shed labels without wrapping at tablet widths. Below md the row
  // holds just the logo, gear and overflow button, so a scrollable header there
  // would be a bug, not a fallback.
  return (
    <div className="h-[calc(52px+env(safe-area-inset-top))] pt-[env(safe-area-inset-top)] md:h-[60px] md:pt-0 flex items-stretch md:overflow-x-auto md:overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden bg-white dark:bg-gray-900 border-b border-gray-100 dark:border-gray-800">
      <button
        onClick={goHome}
        className="flex min-w-0 md:shrink-0 items-center gap-2.5 px-3 md:px-5 cursor-pointer"
        title="Draft Helper home"
      >
        <div className="w-[30px] h-[30px] md:w-[34px] md:h-[34px] shrink-0 rounded-[9px] bg-gradient-to-br from-blue-700 to-blue-900 text-white flex items-center justify-center font-extrabold text-xs md:text-sm">
          FF
        </div>
        {/* Kept below sm now that the phone header carries only three
            controls — it truncates there rather than being dropped. */}
        <span className="truncate sm:whitespace-nowrap text-[15px] font-extrabold tracking-tight text-gray-900 dark:text-white">
          Draft Helper
        </span>
      </button>

      <nav className="hidden md:flex shrink-0 items-center gap-1 px-2">
        {showLiveNavigation ? navigationItems.map((item) => {
          const Icon = item.icon;
          const isActive = currentView === item.id;
          return (
            <button
              key={item.id}
              onClick={() => setCurrentView(item.id)}
              className={cn(
                'flex items-center gap-2 px-3.5 py-2 rounded-[10px] text-[13.5px] font-semibold whitespace-nowrap transition-colors cursor-pointer',
                isActive
                  ? 'bg-blue-50 text-blue-700 dark:bg-blue-900/20 dark:text-blue-400'
                  : 'text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800'
              )}
              title={item.label}
            >
              <Icon className="h-[18px] w-[18px] shrink-0" />
              <span className="hidden lg:inline">{item.label}</span>
            </button>
          );
        }) : null}
      </nav>

      <div className="min-w-4 flex-1" />

      <MobileNavActions actions={actions} showLiveNavigation={showLiveNavigation} />

      <div className="hidden md:flex shrink-0 items-center gap-1.5 px-4">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              title="More actions"
              aria-label="More actions"
              className="flex h-[38px] w-[38px] cursor-pointer items-center justify-center rounded-[9px] text-gray-600 transition-colors hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800"
            >
              <Ellipsis className="h-[19px] w-[19px]" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            {actions.map((action) => {
              const Icon = action.icon;
              return (
                <DropdownMenuItem
                  key={action.id}
                  variant={action.destructive ? 'destructive' : 'default'}
                  onSelect={action.onSelect}
                >
                  <Icon />
                  {action.label}
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>
        {showLiveNavigation && (
          <button
            onClick={() => setShowWatchlist(!showWatchlist)}
            title={showWatchlist ? 'Hide Watchlist' : 'Show Watchlist'}
            className={cn(
              'h-[38px] px-3 rounded-[9px] border flex items-center gap-[7px] text-[12.5px] font-bold transition-colors cursor-pointer',
              showWatchlist
                ? 'border-green-200 bg-green-50 text-green-700 hover:bg-green-100 dark:border-green-800 dark:bg-green-900/20 dark:text-green-400'
                : 'border-gray-200 bg-white text-gray-600 hover:bg-gray-100 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-800'
            )}
          >
            <Eye className="h-[18px] w-[18px] shrink-0" />
            <span className="hidden lg:inline whitespace-nowrap">Watchlist</span>
          </button>
        )}
        <button
          onClick={signOut}
          title="Sign out"
          className="w-[38px] h-[38px] rounded-[9px] flex items-center justify-center text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800 transition-colors cursor-pointer"
        >
          <LogOut className="h-[19px] w-[19px]" />
        </button>
      </div>
      <EndDraftDialog
        open={endDraftOpen && isOwnActiveDraft}
        onOpenChange={setEndDraftOpen}
      />
    </div>
  );
}

function MenuRow({
  icon: Icon,
  label,
  onClick,
  destructive,
}: {
  icon: ComponentType<{ className?: string }>;
  label: string;
  onClick: () => void;
  destructive?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex min-h-12 items-center gap-3 rounded-lg px-3 text-left text-sm font-semibold transition-colors active:bg-gray-100 dark:active:bg-gray-800',
        destructive
          ? 'text-red-600 dark:text-red-400'
          : 'text-gray-700 dark:text-gray-200'
      )}
    >
      <Icon className="h-[18px] w-[18px] shrink-0" />
      {label}
    </button>
  );
}

// Phone-width right-hand cluster: everything from the desktop TierOneBar
// lives one tap deep in the overflow sheet.
function MobileNavActions({
  actions,
  showLiveNavigation,
}: {
  actions: HeaderAction[];
  showLiveNavigation: boolean;
}) {
  const { muted, setMuted } = useNotificationPreferences();

  const [menuOpen, setMenuOpen] = useState(false);
  const [watchlistOpen, setWatchlistOpen] = useState(false);

  return (
    <div className="flex md:hidden items-center pr-1">
      {/* Watchlist is a during-the-draft reflex — it stays a one-tap icon here
          rather than living behind the overflow sheet. */}
      {showLiveNavigation && (
        <button
          onClick={() => setWatchlistOpen(true)}
          title="Watchlist"
          aria-label="Watchlist"
          className="flex h-11 w-11 items-center justify-center rounded-[9px] text-gray-600 transition-colors dark:text-gray-300"
        >
          <Eye className="h-5 w-5" />
        </button>
      )}

      <button
        onClick={() => setMenuOpen(true)}
        title="More actions"
        aria-label="More actions"
        className="flex h-11 w-11 items-center justify-center rounded-[9px] text-gray-600 transition-colors dark:text-gray-300"
      >
        <Ellipsis className="h-5 w-5" />
      </button>

      <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
        <SheetContent
          side="bottom"
          aria-describedby={undefined}
          className="gap-0 p-0 pb-[env(safe-area-inset-bottom)]"
        >
          <SheetHeader className="border-b border-gray-200 dark:border-gray-800">
            <SheetTitle className="text-base">Menu</SheetTitle>
          </SheetHeader>
          <div className="flex flex-col p-2">
            {actions.map((action) => (
              <MenuRow
                key={action.id}
                icon={action.icon}
                label={action.label}
                destructive={action.destructive}
                onClick={() => {
                  action.onSelect();
                  setMenuOpen(false);
                }}
              />
            ))}
            <MenuRow
              icon={muted ? BellOff : Bell}
              label={muted ? 'Unmute turn alerts' : 'Mute turn alerts'}
              onClick={() => setMuted(!muted)}
            />
            <MenuRow icon={LogOut} label="Sign out" onClick={signOut} />
          </div>
        </SheetContent>
      </Sheet>

      {/* The sidebar brings its own close button, so suppress SheetContent's
          built-in one (its only direct child that is a <button>). */}
      <Sheet open={watchlistOpen} onOpenChange={setWatchlistOpen}>
        <SheetContent
          side="right"
          aria-describedby={undefined}
          className="w-full gap-0 p-0 [&>button]:hidden"
        >
          <SheetTitle className="sr-only">Watchlist</SheetTitle>
          <WatchlistSidebar
            className="w-full flex-1 border-l-0"
            onClose={() => setWatchlistOpen(false)}
          />
        </SheetContent>
      </Sheet>
    </div>
  );
}

// Turn state as a ticker segment rather than the full-width banner it replaced
// (NFI-53): same message, same mute toggle, none of the vertical space.
function TurnSegment() {
  const { onTheClock, message, upNext, upNextMessage } = useOnTheClockState();
  const { muted, setMuted } = useNotificationPreferences();

  if (!onTheClock && !upNext) return null;

  const full = onTheClock ? message : upNextMessage;

  return (
    // Below lg the bar is already tight (LiveDraftSegment drops out there for
    // the same reason), so the label shortens to two words rather than pushing
    // the bid controls off-screen on a tablet.
    <div
      title={full}
      className={cn(
        'flex shrink-0 items-center gap-2 self-center rounded-full py-1 pl-2.5 pr-1.5 text-[13px] font-semibold ml-3',
        onTheClock
          ? 'bg-amber-100/70 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300'
          : 'bg-blue-100/60 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300'
      )}
    >
      {!onTheClock && <Clock3 className="h-4 w-4 shrink-0" />}
      <span className="whitespace-nowrap lg:hidden">{onTheClock ? 'Your turn' : 'Up next'}</span>
      <span className="hidden whitespace-nowrap lg:inline">{full}</span>
      <button
        type="button"
        onClick={() => setMuted(!muted)}
        title={muted ? 'Unmute turn notifications' : 'Mute turn notifications'}
        aria-label={muted ? 'Unmute turn notifications' : 'Mute turn notifications'}
        className={cn(
          'flex h-6 w-6 shrink-0 items-center justify-center rounded-full transition-opacity hover:opacity-100',
          !onTheClock && 'opacity-50'
        )}
      >
        {onTheClock ? (
          // A ping halo behind the bell — animate-pulse on the glyph alone was
          // too subtle to read as "act now".
          <span className="relative flex h-4 w-4 shrink-0 items-center justify-center">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400 opacity-60" />
            {muted ? <BellOff className="relative h-3.5 w-3.5" /> : <Bell className="relative h-3.5 w-3.5" />}
          </span>
        ) : muted ? (
          <BellOff className="h-3.5 w-3.5" />
        ) : (
          <Bell className="h-3.5 w-3.5" />
        )}
      </button>
    </div>
  );
}

function LiveDraftSegment() {
  const { selectedAuction } = useAuction();
  if (!selectedAuction || selectedAuction.status !== 'active') return null;

  return (
    // Which draft you are in is already obvious from being in the room; below
    // lg the width is worth more to the bid controls.
    <div className="hidden shrink-0 items-center gap-2.5 px-[18px] border-r border-gray-200 lg:flex dark:border-gray-700">
      <span className="relative w-[9px] h-[9px] shrink-0 rounded-full bg-emerald-500 animate-pulse" />
      <div className="flex min-w-0 flex-col leading-[1.2]">
        <span className="text-[9px] font-bold text-gray-400 tracking-[0.06em]">LIVE DRAFT</span>
        {/* Capped so one long draft name can't crowd out the rest of the ticker. */}
        <span className="max-w-[220px] truncate text-[13px] font-bold text-gray-900 dark:text-white" title={selectedAuction.name}>
          {selectedAuction.name}
        </span>
      </div>
      <span
        className={cn(
          'shrink-0 text-[10px] font-extrabold rounded-md px-[7px] py-[2px] tracking-[0.04em]',
          selectedAuction.type === 'official'
            ? 'text-emerald-700 bg-emerald-100 dark:text-emerald-400 dark:bg-emerald-900/30'
            : 'text-gray-600 bg-gray-200 dark:text-gray-300 dark:bg-gray-700'
        )}
      >
        {selectedAuction.type.toUpperCase()}
      </span>
    </div>
  );
}

// `busy` = the ticker is already carrying a nomination and its bid controls, so
// the queue needs a wider screen before it earns its place. Dropping it is
// better than leaving a stub that only a horizontal scroll can reveal.
function NominatingQueue({ busy, className }: { busy?: boolean; className?: string }) {
  const { data: draftPicks = [] } = useAllDraftPicks();
  const { data: teams = [] } = useAuctionTeams();
  const { settings } = useLeague();

  const nominatorId = getNominatorForPick(draftPicks.length, draftPicks, teams, settings.paidAuctionSlots);
  const nextNominatorId = getNominatorForPick(draftPicks.length + 1, draftPicks, teams, settings.paidAuctionSlots);
  const teamById = new Map(teams.map((t) => [t.id, t]));
  const nominator = nominatorId ? teamById.get(nominatorId) : undefined;
  const nextNominator = nextNominatorId ? teamById.get(nextNominatorId) : undefined;

  if (!nominator && !nextNominator) return null;

  // Dropped below lg in the desktop ticker so the bid controls always fit; the
  // mobile ticker passes its own display class to bring it back inside the
  // expanded panel, where there is room for it.
  return (
    <div className={cn('hidden min-w-0 items-center gap-3 px-5', busy ? 'xl:flex' : 'lg:flex', className)}>
      <span className="shrink-0 text-[9px] font-bold text-gray-400 tracking-[0.06em]">NOMINATING</span>
      <div className="flex min-w-0 items-center gap-2">
        {nominator && <NominatorChip team={nominator} current />}
        {nominator && nextNominator && (
          <ArrowRight className="h-[15px] w-[15px] shrink-0 text-gray-300 dark:text-gray-600" />
        )}
        {nextNominator && <NominatorChip team={nextNominator} />}
      </div>
    </div>
  );
}

function AuctionTicker() {
  const { activePlayer, canClearActivePlayer, setActivePlayer } = useActiveDraft();
  const { simFlagged } = useMockDraft();
  const { data: draftPicks = [] } = useAllDraftPicks();
  const userTeamId = useUserTeamId();
  const { settings } = useLeague();
  const [auctionValue, setAuctionValue] = useState('');
  const [isConfirmModalOpen, setIsConfirmModalOpen] = useState(false);

  // Reset the bid input whenever a different player becomes active.
  useEffect(() => {
    setAuctionValue('');
  }, [activePlayer?.id]);

  const budgetSummary = calculateBudgetSummary(
    draftPicks.filter((pick) => pick.fantasy_team_id === userTeamId),
    settings
  );

  const handleSubmit = () => {
    if (auctionValue.trim()) setIsConfirmModalOpen(true);
  };

  const handleDraftSuccess = () => {
    setAuctionValue('');
    setActivePlayer(null);
    setIsConfirmModalOpen(false);
  };

  return (
    <>
      {activePlayer ? (
        <>
          <div className="flex shrink-0 items-center gap-3 px-4 border-r border-gray-200 dark:border-gray-700">
            <PlayerAvatar
              name={activePlayer.name}
              position={activePlayer.position}
              team={activePlayer.team}
              sleeperId={activePlayer.sleeper_id}
              espnId={activePlayer.espn_id}
              size={34}
            />
            <div className="flex flex-col leading-[1.2]">
              <span className="text-[9px] font-extrabold text-blue-600 tracking-[0.06em]">
                UP FOR AUCTION
              </span>
              <span className="text-sm font-extrabold text-gray-900 dark:text-white whitespace-nowrap flex items-center gap-1.5">
                <PlayerNameButton player={activePlayer} className="font-extrabold" />
                <PositionBadge position={activePlayer.position} className="text-[10.5px] px-1.5 py-0" />
              </span>
            </div>
            {/* Reference prices — nice to have, first thing to go when narrow. */}
            <div className="hidden gap-3 pl-1 lg:flex">
              {activePlayer.projected_auction_value != null && (
                <div className="flex flex-col items-end leading-[1.1]">
                  <span className="text-[8.5px] text-gray-400">PROJ</span>
                  <span className="text-[13px] font-extrabold text-gray-900 dark:text-white tabular-nums">
                    ${activePlayer.projected_auction_value}
                  </span>
                </div>
              )}
            </div>
          </div>

          {!simFlagged && (
            <div className="flex shrink-0 items-center gap-2.5 px-4 border-r border-gray-200 dark:border-gray-700">
              <div className="flex flex-col items-end leading-[1.1]">
                <span className="text-[8.5px] text-blue-700 dark:text-blue-400 font-bold tracking-[0.03em]">
                  YOUR MAX
                </span>
                <span className="text-[15px] font-extrabold text-blue-900 dark:text-blue-300 tabular-nums">
                  ${budgetSummary.maxBid}
                </span>
              </div>
              <div className="flex items-center gap-1 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-[9px] pl-2.5 pr-1 py-1 shadow-sm">
                <DollarSign className="h-4 w-4 text-gray-400" />
                <Input
                  type="number"
                  placeholder="0"
                  value={auctionValue}
                  onChange={(e) => setAuctionValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleSubmit();
                  }}
                  className="h-7 w-14 border-0 bg-transparent shadow-none focus-visible:ring-0 px-0 text-[15px] font-bold"
                  min="0"
                  step="1"
                />
                <Button
                  size="sm"
                  onClick={handleSubmit}
                  disabled={!auctionValue.trim()}
                  className="h-[30px] w-[30px] p-0 bg-green-600 hover:bg-green-700 rounded-[7px]"
                  title="Confirm winning bid"
                >
                  <Check className="h-4 w-4" />
                </Button>
              </div>
              {canClearActivePlayer && (
                <button
                  onClick={() => setActivePlayer(null)}
                  title="Remove nomination"
                  className="w-7 h-7 rounded-[7px] flex items-center justify-center text-gray-400 hover:bg-red-100 hover:text-red-600 dark:hover:bg-red-900/30 transition-colors cursor-pointer"
                >
                  <X className="h-[15px] w-[15px]" />
                </button>
              )}
            </div>
          )}
        </>
      ) : (
        <div className="flex items-center px-4 border-r border-gray-200 dark:border-gray-700">
          <span className="text-[13px] text-gray-400 whitespace-nowrap">No player nominated</span>
        </div>
      )}

      <div className="flex-1" />

      <NominatingQueue busy={!!activePlayer} />

      {activePlayer && (
        <DraftConfirmationModal
          isOpen={isConfirmModalOpen}
          onClose={() => setIsConfirmModalOpen(false)}
          player={activePlayer}
          initialValue={auctionValue}
          onSuccess={handleDraftSuccess}
        />
      )}
    </>
  );
}

function NominatorChip({ team, current }: { team: FantasyTeam; current?: boolean }) {
  return (
    <div className={cn('flex min-w-0 items-center gap-1.5', !current && 'opacity-70')}>
      <div
        className={cn(
          'rounded-full shrink-0 flex items-center justify-center font-extrabold',
          current
            ? 'w-[26px] h-[26px] text-[10px] bg-emerald-100 text-emerald-700 ring-2 ring-emerald-500 dark:bg-emerald-900/40 dark:text-emerald-400'
            : 'w-6 h-6 text-[9.5px] bg-gray-200 text-gray-600 dark:bg-gray-700 dark:text-gray-300'
        )}
      >
        {team.draft_order}
      </div>
      <span
        title={team.name}
        className={cn(
          // Floor so the name degrades to an ellipsis rather than to nothing;
          // past that the ticker scrolls instead of shrinking further.
          'min-w-[3.25rem] truncate',
          current
            ? 'text-xs font-bold text-gray-900 dark:text-white'
            : 'text-[11.5px] font-semibold text-gray-600 dark:text-gray-300'
        )}
      >
        {team.name}
      </span>
    </div>
  );
}

function SnakeTicker() {
  const { data: teams = [] } = useAuctionTeams();
  const { data: draftPicks = [] } = useAllDraftPicks();
  const { settings } = useLeague();

  const snakeTeamQueue = calculateCurrentSnakeTeam(teams, draftPicks.length, settings.paidAuctionSlots);

  if (!snakeTeamQueue.currentTeam) {
    return (
      <div className="flex items-center px-4">
        <span className="text-[13px] text-gray-400">Auction phase in progress</span>
      </div>
    );
  }

  return (
    <>
      <div className="flex items-center gap-3 px-4 border-r border-gray-200 dark:border-gray-700">
        <div className="flex flex-col leading-[1.2]">
          <span className="text-[9px] font-extrabold text-indigo-600 dark:text-indigo-400 tracking-[0.06em]">
            SNAKE DRAFT
          </span>
          <div className="flex items-center gap-2">
            <div className="w-[26px] h-[26px] rounded-full bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300 flex items-center justify-center text-[10px] font-extrabold ring-2 ring-indigo-500">
              {snakeTeamQueue.currentTeam.draft_order}
            </div>
            <span className="text-sm font-extrabold text-gray-900 dark:text-white whitespace-nowrap">
              {snakeTeamQueue.currentTeam.name}
            </span>
            <span className="text-[10px] font-bold text-gray-400 whitespace-nowrap">
              ON THE CLOCK · {getTeamPickCount(snakeTeamQueue.currentTeam.id, draftPicks)} picks
            </span>
          </div>
        </div>
        {snakeTeamQueue.nextTeam && (
          <>
            <ArrowRight className="h-[15px] w-[15px] text-gray-300 dark:text-gray-600" />
            <div className="flex items-center gap-2 opacity-70">
              <div className="w-6 h-6 rounded-full bg-gray-200 text-gray-600 dark:bg-gray-700 dark:text-gray-300 flex items-center justify-center text-[9.5px] font-bold">
                {snakeTeamQueue.nextTeam.draft_order}
              </div>
              <span className="text-[11.5px] font-semibold text-gray-600 dark:text-gray-300 whitespace-nowrap">
                {snakeTeamQueue.nextTeam.name}
              </span>
              <span className="text-[9px] font-bold text-gray-400 whitespace-nowrap">
                UP NEXT · {getTeamPickCount(snakeTeamQueue.nextTeam.id, draftPicks)} picks
              </span>
            </div>
          </>
        )}
      </div>

      <div className="flex-1" />

      <div className="flex items-center px-5">
        <span className="text-[11px] font-bold text-gray-500 dark:text-gray-400 bg-gray-100 dark:bg-gray-800 rounded-md px-2.5 py-1 whitespace-nowrap tabular-nums">
          Pick #{draftPicks.length + 1}
        </span>
      </div>
    </>
  );
}

function SimTicker() {
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

  if (disabledReason) {
    return (
      <div className="flex items-center px-4">
        <span className="flex items-center gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-900/20 dark:text-amber-300">
          <TriangleAlert className="h-3.5 w-3.5 shrink-0" />
          {disabledReason}
        </span>
      </div>
    );
  }

  if (!isActive) {
    return (
      <div className="flex items-center px-4">
        <span className="text-[13px] text-gray-400">Simulation not running</span>
      </div>
    );
  }

  if (status === 'complete') {
    return (
      <div className="flex items-center gap-2.5 px-4">
        <Trophy className="h-5 w-5 text-amber-500" />
        <span className="text-sm font-bold text-gray-900 dark:text-white">Mock draft complete</span>
        <span className="text-xs text-gray-400">Every roster is full — review the board</span>
      </div>
    );
  }

  const pauseButton = (
    <button
      onClick={() => setPaused(!paused)}
      title={paused ? 'Resume simulation' : 'Pause simulation'}
      className="w-7 h-7 rounded-[7px] flex items-center justify-center text-gray-500 hover:bg-gray-200 dark:text-gray-400 dark:hover:bg-gray-700 transition-colors cursor-pointer"
    >
      {paused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
    </button>
  );

  if (paused) {
    return (
      <>
        <div className="flex items-center gap-2.5 px-4">
          <span className="text-[13px] text-gray-500 dark:text-gray-400">Simulation paused</span>
          {pauseButton}
        </div>
      </>
    );
  }

  if (phase === 'snake') {
    const round = getSnakeRound(nextPickOrder, teams.length, settings.paidAuctionSlots);
    return (
      <>
        <div className="flex items-center gap-3 px-4 border-r border-gray-200 dark:border-gray-700">
          <div className="flex flex-col leading-[1.2]">
            <span className="text-[9px] font-extrabold text-indigo-600 dark:text-indigo-400 tracking-[0.06em]">
              SNAKE · ROUND {round}
            </span>
            {status === 'snake-user' ? (
              <span className="text-sm font-extrabold text-gray-900 dark:text-white whitespace-nowrap">
                Your pick (#{nextPickOrder}) — pick a player from the table
              </span>
            ) : (
              <span className="text-[13px] text-gray-600 dark:text-gray-300 whitespace-nowrap">
                {currentTeam?.name ?? 'A team'} is picking…
              </span>
            )}
          </div>
          {status === 'snake-ai' && (
            <div className="flex items-center gap-2">
              <label className="flex items-center gap-1.5 text-[11px] text-gray-500 dark:text-gray-400 whitespace-nowrap cursor-pointer">
                <input
                  type="checkbox"
                  checked={autoAdvance}
                  onChange={(e) => setAutoAdvance(e.target.checked)}
                />
                Auto-advance
              </label>
              {!autoAdvance && (
                <Button size="sm" variant="outline" className="h-7 text-xs" onClick={stepSnake}>
                  Advance one pick
                </Button>
              )}
            </div>
          )}
        </div>
        <div className="flex-1" />
        <div className="flex items-center gap-2 px-5">
          <span className="text-[11px] font-bold text-gray-500 dark:text-gray-400 bg-gray-100 dark:bg-gray-800 rounded-md px-2.5 py-1 whitespace-nowrap tabular-nums">
            Pick #{nextPickOrder}
          </span>
          {pauseButton}
        </div>
      </>
    );
  }

  // Auction phase — user's turn to nominate; row clicks nominate directly.
  if (status === 'user-nominate') {
    return (
      <>
        <div className="flex items-center gap-3 px-4 border-r border-gray-200 dark:border-gray-700">
          <div className="flex flex-col leading-[1.2]">
            <span className="text-[9px] font-extrabold text-blue-600 tracking-[0.06em]">
              YOUR NOMINATION
            </span>
            <span className="text-[13px] text-gray-600 dark:text-gray-300 whitespace-nowrap">
              Pick a player from the table
            </span>
          </div>
          <div className="flex flex-col items-end leading-[1.1]">
            <span className="text-[8.5px] text-blue-700 dark:text-blue-400 font-bold tracking-[0.03em]">
              YOUR MAX
            </span>
            <span className="text-[15px] font-extrabold text-blue-900 dark:text-blue-300 tabular-nums">
              ${userMaxBid}
            </span>
          </div>
        </div>
        <div className="flex-1" />
        <NominatingQueue />
        <div className="flex items-center pr-4">{pauseButton}</div>
      </>
    );
  }

  // Auction phase — a nomination is on the table.
  if (pending) {
    return (
      <>
        {/* Content-sized like the live-auction player block: the row below is
            nowrap, so letting this shrink would overlap it with the outcome
            badge rather than reflow it. The ticker scrolls instead. */}
        <div className="flex shrink-0 items-center gap-3 px-4 border-r border-gray-200 dark:border-gray-700">
          <div className="flex min-w-0 flex-col leading-[1.2]">
            <span className="max-w-[260px] truncate text-[9px] font-extrabold text-blue-600 tracking-[0.06em]">
              {pending.reason === 'user'
                ? 'YOUR NOMINATION'
                : `${pending.nominatorTeam?.name ?? 'A team'} NOMINATES${pending.reason === 'drain' ? ' (BUDGET DRAIN)' : ''}`}
            </span>
            {/* truncate on the name is the belt to the block's shrink-0 braces:
                the name is nowrap, so if anything ever does compress this it
                shortens rather than painting over its neighbour. */}
            <span className="flex min-w-0 items-center gap-1.5">
              <PlayerAvatar
                name={pending.player.name}
                position={pending.player.position}
                team={pending.player.team}
                sleeperId={pending.player.sleeper_id}
                espnId={pending.player.espn_id}
                size={26}
              />
              <span className="flex min-w-0 flex-col leading-[1.15] xl:flex-row xl:items-center xl:gap-1.5">
                <span className="flex min-w-0 items-center gap-1.5">
                  <PlayerNameButton
                    player={pending.player}
                    className="truncate text-sm font-extrabold text-gray-900 dark:text-white"
                  />
                  <PositionBadge position={pending.player.position} className="shrink-0 text-[10.5px] px-1.5 py-0" />
                </span>
                {/* Stacked below xl rather than dropped: on its own line the
                    meta costs no horizontal room, so it no longer pushes the
                    Pass / Bid buttons out of the bar at 1024 — the reason it
                    used to be hidden there. */}
                <span className="truncate text-[10px] text-gray-400 xl:whitespace-nowrap">
                  Ovr #{pending.player.rank} · Pos #{pending.player.position_rank} · Tier {pending.player.tier}
                </span>
              </span>
            </span>
          </div>
          <div
            className="shrink-0 rounded-lg bg-amber-50 dark:bg-amber-900/20 px-2.5 py-1 text-xs text-gray-700 dark:text-gray-200 whitespace-nowrap"
            title={pending.log.join('\n') || undefined}
          >
            {pending.uncontested ? (
              <span>No AI interest — draft for <span className="font-bold">${pending.price}</span></span>
            ) : (
              <span>
                <span className="font-bold">{pending.winnerTeam?.name ?? 'A team'}</span> wins at{' '}
                <span className="font-bold">${pending.price}</span>
              </span>
            )}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2 px-4 border-r border-gray-200 dark:border-gray-700">
          <div className="flex flex-col items-end leading-[1.1]">
            <span className="text-[8.5px] text-blue-700 dark:text-blue-400 font-bold tracking-[0.03em]">
              YOUR MAX
            </span>
            <span className="text-[15px] font-extrabold text-blue-900 dark:text-blue-300 tabular-nums">
              ${userMaxBid}
            </span>
          </div>
          <MockBidActions
            pending={pending}
            userMaxBid={userMaxBid}
            onPass={pass}
            onBid={counter}
            compact
          />
        </div>

        <div className="flex-1" />
        <NominatingQueue busy />
        <div className="flex items-center pr-4">{pauseButton}</div>
      </>
    );
  }

  // Transient: AI about to nominate.
  return (
    <>
      <div className="flex items-center gap-2.5 px-4">
        <span className="text-[13px] text-gray-400">
          {currentTeam?.name ?? 'A team'} is nominating…
        </span>
        {pauseButton}
      </div>
      <div className="flex-1" />
      <NominatingQueue />
    </>
  );
}

function LiveTicker() {
  const { isSnakeMode } = useNavigation();
  const { simFlagged } = useMockDraft();
  const isDraftRoom = useIsDraftRoom();
  const isMobile = useIsMobile();

  // Historical and landing/history surfaces are view-only — no live ticker.
  // Phones get the bottom-docked MobileNominationTicker instead (NFI-57).
  if (!isDraftRoom || isMobile) return null;

  return (
    // overflow-x-auto: the segments below are content-sized, so without it a
    // busy ticker widens the whole document and every fixed-width row above
    // stops short of the scrolled area (NFI-47). Scrolling the bar rather than
    // clipping it keeps the bid controls reachable on the narrowest screens.
    // The scrollbar is hidden (it would eat a quarter of a 56px bar), so the
    // region is a labelled tab stop — otherwise the overflowed nominating
    // queue, which is plain text, is unreachable without a pointer.
    <div
      role="region"
      aria-label="Live draft status"
      tabIndex={0}
      className="h-14 flex items-stretch overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden bg-gradient-to-b from-slate-50 to-slate-100 dark:from-gray-900 dark:to-gray-850 border-b border-gray-200 dark:border-gray-700"
    >
      <LiveDraftSegment />
      <TurnSegment />
      {simFlagged ? (
        <>
          <SimTicker />
          <WinConfetti />
        </>
      ) : isSnakeMode ? (
        <SnakeTicker />
      ) : (
        <AuctionTicker />
      )}
    </div>
  );
}

export function TopNavbar() {
  return (
    // z-50 keeps the navbar above the mobile ticker's scrim (z-30) — the
    // handoff calls the navbar and tab bar untouchable while the sheet is open.
    <header className="relative z-50 shrink-0">
      <TierOneBar />
      <LiveTicker />
    </header>
  );
}
