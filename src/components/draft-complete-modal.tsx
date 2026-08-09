'use client';

import { useMemo } from 'react';
import { LayoutDashboard, Trophy, Users } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from '@/components/ui/sheet';
import { useAuction } from '@/contexts/auction-context';
import { useNavigation } from '@/contexts/navigation-context';
import { useAllDraftPicks } from '@/hooks/use-draft-picks';
import { useIsMobile } from '@/hooks/use-is-mobile';
import { useUserTeamId } from '@/hooks/use-league';
import { formatDraftDuration, getDraftHighlights } from '@/lib/draft-highlights';

function RecapItem({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="rounded-xl border bg-gray-50 p-3.5 dark:bg-gray-900">
      <div className="text-[10px] font-bold uppercase tracking-[0.08em] text-gray-400">{label}</div>
      <div className="mt-1.5 text-lg font-extrabold tabular-nums text-gray-900 dark:text-white">{value}</div>
      <div className="mt-0.5 truncate text-xs text-gray-500 dark:text-gray-400">{detail}</div>
    </div>
  );
}

function DraftCompleteContent() {
  const { selectedAuction } = useAuction();
  const {
    setCurrentView,
    setLandingOverride,
    returnToDashboard,
    setCompletedDraftModalOpen,
  } = useNavigation();
  const { data: picks = [], isLoading, isError } = useAllDraftPicks();
  const userTeamId = useUserTeamId();
  const highlights = useMemo(
    () => getDraftHighlights(picks, userTeamId),
    [picks, userTeamId],
  );

  const viewDraftBoard = () => {
    setLandingOverride(false);
    setCurrentView('draft-history');
    setCompletedDraftModalOpen(false);
  };

  const dismissToDashboard = () => {
    returnToDashboard();
    setCompletedDraftModalOpen(false);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex-1 overflow-y-auto px-4 pt-5 md:px-0 md:pt-0">
        <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300">
          <Trophy className="size-6" />
        </div>
        <div className="mt-3 text-center">
          <h2 className="text-2xl font-extrabold tracking-[-0.02em] text-gray-900 dark:text-white">Draft complete</h2>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            {selectedAuction?.name ?? 'Your draft'} is in the books.
          </p>
        </div>

        {isLoading ? (
          <div className="py-10 text-center text-sm text-gray-500">Loading draft recap…</div>
        ) : isError ? (
          <div className="py-10 text-center text-sm text-gray-500">Draft recap is unavailable, but the final board is ready.</div>
        ) : (
          <>
            <div className="mt-5 grid grid-cols-2 gap-2.5">
              <RecapItem
                label="Priciest pick"
                value={highlights.priciest?.price == null ? '—' : `$${highlights.priciest.price}`}
                detail={highlights.priciest?.player.name ?? 'No priced picks'}
              />
              <RecapItem
                label="Biggest bargain"
                value={highlights.biggestBargain ? `$${highlights.biggestBargain.difference} under` : '—'}
                detail={highlights.biggestBargain?.pick.player.name ?? 'No projections'}
              />
              <RecapItem
                label="Biggest overpay"
                value={highlights.biggestOverpay ? `$${highlights.biggestOverpay.difference} over` : '—'}
                detail={highlights.biggestOverpay?.pick.player.name ?? 'No projections'}
              />
              <RecapItem
                label="Draft duration"
                value={formatDraftDuration(highlights.durationMs)}
                detail="First pick to final pick"
              />
            </div>

            {highlights.viewerLine && (
              <div className="mt-3 flex items-center gap-2 rounded-xl bg-blue-50 px-3.5 py-3 text-sm font-semibold text-blue-800 dark:bg-blue-950/50 dark:text-blue-300">
                <Users className="size-4 shrink-0" />
                <span>{highlights.viewerLine}</span>
              </div>
            )}
          </>
        )}
      </div>

      <div className="grid shrink-0 gap-2 border-t p-4 pb-[max(1rem,env(safe-area-inset-bottom))] md:mt-5 md:grid-cols-2 md:border-0 md:p-0">
        <Button className="min-h-11 bg-blue-700 font-bold hover:bg-blue-800" onClick={viewDraftBoard}>
          <Trophy className="size-4" />
          View draft board
        </Button>
        <Button variant="outline" className="min-h-11 font-bold" onClick={dismissToDashboard}>
          <LayoutDashboard className="size-4" />
          Return to dashboard
        </Button>
      </div>
    </div>
  );
}

export function DraftCompleteModal({ open }: { open: boolean }) {
  const isMobile = useIsMobile();

  if (isMobile) {
    return (
      <Sheet open={open}>
        <SheetContent
          side="bottom"
          className="max-h-[92dvh] gap-0 p-0 [&>button]:hidden"
          onEscapeKeyDown={(event) => event.preventDefault()}
          onInteractOutside={(event) => event.preventDefault()}
          onPointerDownOutside={(event) => event.preventDefault()}
        >
          <SheetTitle className="sr-only">Draft complete</SheetTitle>
          <SheetDescription className="sr-only">Review the completed draft or return to the dashboard.</SheetDescription>
          <DraftCompleteContent />
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <Dialog open={open}>
      <DialogContent
        showCloseButton={false}
        className="max-w-xl gap-0"
        onEscapeKeyDown={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
        onPointerDownOutside={(event) => event.preventDefault()}
      >
        <DialogTitle className="sr-only">Draft complete</DialogTitle>
        <DialogDescription className="sr-only">Review the completed draft or return to the dashboard.</DialogDescription>
        <DraftCompleteContent />
      </DialogContent>
    </Dialog>
  );
}
