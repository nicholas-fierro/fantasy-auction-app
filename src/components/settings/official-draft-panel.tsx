'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Gavel, Plus, CheckCircle, Trash2, Eye, Lock } from 'lucide-react';
import { pb } from '@/lib/pb-client';
import { useAuction } from '@/contexts/auction-context';
import { useNavigation } from '@/contexts/navigation-context';
import { useLeague, useDraftRole } from '@/hooks/use-league';
import { useAllFantasyTeams } from '@/hooks/use-fantasy-teams';
import { useCompleteAuction, useDeleteAuction } from '@/hooks/use-auctions';
import { NewAuctionModal } from '@/components/new-auction-modal';
import { PickCorrectionsSheet } from '@/components/pick-corrections-sheet';
import {
  Card,
  CardContent,
} from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

// Coarse relative time — good enough for a "last pick 2m ago" style label.
function relativeTime(iso: string): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return '—';
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

export function OfficialDraftPanel() {
  const { auctions, selectedAuctionId } = useAuction();
  const { enterDraftRoom } = useNavigation();
  const { settings } = useLeague();
  const { canPickAnyTeam } = useDraftRole();
  const { data: teams = [] } = useAllFantasyTeams();
  const completeAuction = useCompleteAuction();
  const deleteAuction = useDeleteAuction();

  const [showNewAuction, setShowNewAuction] = useState(false);
  const [showCompleteConfirm, setShowCompleteConfirm] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  const activeOfficial =
    auctions.find((a) => a.type === 'official' && a.status === 'active') ?? null;

  // Lightweight pick summary (count + latest) for the active official draft,
  // independent of which auction is currently selected — no season hydration.
  const { data: picks = [] } = useQuery({
    queryKey: ['draft-picks-summary', activeOfficial?.id],
    queryFn: () =>
      pb.collection('draft_picks').getFullList({
        filter: pb.filter('auction_id = {:id}', { id: activeOfficial!.id }),
        fields: 'id,pick_order,created,timestamp',
        sort: 'pick_order',
      }),
    enabled: !!activeOfficial,
  });

  const teamCount = teams.length || 12;
  const rosterSize = settings.starterPositions.length + settings.benchSize;
  const totalPicks = teamCount * rosterSize;
  const madePicks = picks.length;
  const progress = totalPicks > 0 ? Math.min(100, Math.round((madePicks / totalPicks) * 100)) : 0;
  const round = teamCount > 0 ? Math.max(1, Math.ceil(madePicks / teamCount)) : 1;
  // Picks come sorted by pick_order, so the last row is the most recent.
  const latest = picks[picks.length - 1] as { created?: string; timestamp?: string } | undefined;
  const lastPickLabel = latest ? relativeTime(latest.timestamp || latest.created || '') : '—';

  const isOwnActive = !!activeOfficial && activeOfficial.user === pb.authStore.record?.id;
  const isSelected = !!activeOfficial && activeOfficial.id === selectedAuctionId;
  const canCorrect = isSelected && canPickAnyTeam;

  const handleComplete = async () => {
    if (!activeOfficial) return;
    try {
      await completeAuction.mutateAsync(activeOfficial.id);
      setShowCompleteConfirm(false);
    } catch (error) {
      console.error('Failed to complete auction:', error);
    }
  };

  const handleDelete = async () => {
    if (!activeOfficial) return;
    try {
      await deleteAuction.mutateAsync(activeOfficial.id);
      setShowDeleteConfirm(false);
    } catch (error) {
      console.error('Failed to delete auction:', error);
    }
  };

  return (
    <div className="flex flex-col gap-5 max-w-4xl">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="font-semibold">Official draft</div>
          <p className="text-sm text-muted-foreground max-w-xl mt-1">
            The league&apos;s real draft. Official prices become trusted historical data used to
            estimate future costs.
          </p>
        </div>
        <Button onClick={() => setShowNewAuction(true)} className="max-md:h-11 max-md:w-full">
          <Plus className="h-4 w-4 mr-2" />
          New official draft
        </Button>
      </div>

      {activeOfficial ? (
        <Card className="gap-0 py-0 overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-4 border-b p-5 max-md:p-4">
            <div className="flex items-center gap-3.5">
              <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-blue-50 text-blue-700 dark:bg-blue-950/50 dark:text-blue-400">
                <Gavel className="h-5 w-5" />
              </div>
              <div>
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-lg font-bold">{activeOfficial.name}</span>
                  <Badge>Official</Badge>
                  <Badge className="bg-emerald-600 text-white border-transparent">Active</Badge>
                </div>
                <div className="text-xs text-muted-foreground mt-1">
                  {activeOfficial.year ? `Season ${activeOfficial.year}` : 'Legacy'} · {teamCount}{' '}
                  teams
                </div>
              </div>
            </div>
            <span className="inline-flex items-center gap-2 rounded-full bg-emerald-50 px-3 py-1.5 text-sm font-semibold text-emerald-600 dark:bg-emerald-950/40 dark:text-emerald-400">
              <span className="h-2 w-2 rounded-full bg-emerald-500" />
              Live
            </span>
          </div>

          <div className="flex flex-col gap-5 p-5 max-md:p-4">
            <div>
              <div className="flex items-baseline justify-between mb-2">
                <span className="text-sm font-medium text-muted-foreground">Draft progress</span>
                <span className="text-sm text-muted-foreground">
                  <b className="text-foreground">{madePicks}</b> of {totalPicks} picks · Round{' '}
                  {round}
                </span>
              </div>
              <div className="h-2.5 rounded-full bg-muted overflow-hidden">
                <div
                  className="h-full rounded-full bg-foreground transition-all"
                  style={{ width: `${progress}%` }}
                />
              </div>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              <div className="rounded-lg border p-3">
                <div className="text-xs text-muted-foreground font-medium">Last pick</div>
                <div className="text-base font-semibold mt-1">{lastPickLabel}</div>
              </div>
              <div className="rounded-lg border p-3">
                <div className="text-xs text-muted-foreground font-medium">Budget</div>
                <div className="text-base font-semibold mt-1">${settings.budget}</div>
              </div>
              <div className="rounded-lg border p-3">
                <div className="text-xs text-muted-foreground font-medium">Teams</div>
                <div className="text-base font-semibold mt-1">{teamCount}</div>
              </div>
            </div>

            <div className="flex items-center gap-2 flex-wrap border-t pt-4 max-md:flex-col max-md:items-stretch">
              {canCorrect ? (
                <PickCorrectionsSheet />
              ) : (
                !isSelected && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="max-md:h-11"
                    onClick={() => enterDraftRoom(activeOfficial.id)}
                  >
                    <Eye className="h-4 w-4 mr-2" />
                    View board
                  </Button>
                )
              )}
              {isOwnActive && (
                <Button
                  variant="outline"
                  size="sm"
                  className="max-md:h-11"
                  onClick={() => setShowCompleteConfirm(true)}
                >
                  <CheckCircle className="h-4 w-4 mr-2" />
                  Complete draft
                </Button>
              )}
              <div className="ml-auto max-md:hidden" />
              {isOwnActive && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setShowDeleteConfirm(true)}
                  className="text-red-600 border-red-200 hover:text-red-700 dark:text-red-400 dark:border-red-900 max-md:h-11"
                >
                  <Trash2 className="h-4 w-4 mr-2" />
                  Delete
                </Button>
              )}
            </div>
          </div>
        </Card>
      ) : (
        <Card>
          <CardContent className="flex items-center gap-3 text-sm text-muted-foreground">
            <Lock className="h-4 w-4" />
            No active official draft. Start one to run the league&apos;s live auction.
          </CardContent>
        </Card>
      )}

      <NewAuctionModal
        isOpen={showNewAuction}
        onClose={() => setShowNewAuction(false)}
        initialType="official"
      />

      <Dialog open={showCompleteConfirm} onOpenChange={setShowCompleteConfirm}>
        <DialogContent variant="alert" className="max-w-md">
          <DialogHeader>
            <DialogTitle>Complete Draft</DialogTitle>
            <DialogDescription>
              {`"${activeOfficial?.name}" will become read-only history. You can still view its board, rosters, and prices, but no more picks or edits.`}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowCompleteConfirm(false)}
              disabled={completeAuction.isPending}
            >
              Cancel
            </Button>
            <Button onClick={handleComplete} disabled={completeAuction.isPending} className="min-w-24">
              {completeAuction.isPending ? 'Saving...' : 'Complete'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
        <DialogContent variant="alert" className="max-w-md">
          <DialogHeader>
            <DialogTitle>Delete Draft</DialogTitle>
            <DialogDescription>
              {`"${activeOfficial?.name}" and its ${madePicks} draft pick${madePicks === 1 ? '' : 's'} will be permanently deleted. This cannot be undone.`}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowDeleteConfirm(false)}
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
        </DialogContent>
      </Dialog>
    </div>
  );
}
