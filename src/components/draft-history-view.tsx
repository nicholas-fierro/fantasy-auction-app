'use client';

import { useMemo, useState } from 'react';
import { ArrowLeft, Check, Dices, Eye, History, Lock, Trash2, Trophy } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { DraftBoard } from '@/components/draft-board';
import { NewAuctionModal } from '@/components/new-auction-modal';
import { TeamRosterCard, PositionLabel, RosterViewToggle, type RosterViewMode } from '@/components/team-roster-card';
import { getDraftHighlights } from '@/lib/draft-highlights';
import { pb } from '@/lib/pb-client';
import { useAuction } from '@/contexts/auction-context';
import { useNavigation } from '@/contexts/navigation-context';
import { useAllDraftPicks } from '@/hooks/use-draft-picks';
import { useAuctionTeams } from '@/hooks/use-fantasy-teams';
import { useIsCommissioner } from '@/hooks/use-league';
import { useDeleteAuction } from '@/hooks/use-auctions';
import type { Auction } from '@/server/types/auction';
import type { DraftPickWithDetails } from '@/server/types/draft-pick';

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? 'Unknown date'
    : date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function DraftHistoryList() {
  const { auctions, setSelectedAuctionId } = useAuction();
  const { returnToDashboard } = useNavigation();
  const isCommissioner = useIsCommissioner();
  const deleteAuction = useDeleteAuction();
  // The auctions list rule hands a commissioner every league member's private
  // mock for oversight. History is a personal archive, so it shows official
  // drafts plus the viewer's own mocks and nothing else.
  const userId = pb.authStore.record?.id;
  const completedDrafts = auctions.filter((auction) =>
    auction.status === 'completed' && (auction.type === 'official' || auction.user === userId)
  );
  const [newDraftType, setNewDraftType] = useState<'official' | 'mock'>('mock');
  const [showNewDraft, setShowNewDraft] = useState(false);
  const [auctionToDelete, setAuctionToDelete] = useState<Auction | null>(null);
  const [isEditing, setIsEditing] = useState(false);

  const openNewDraft = (type: 'official' | 'mock') => {
    setNewDraftType(type);
    setShowNewDraft(true);
  };

  // The mutation's own error state drives the dialog message, so a failed
  // delete is visible instead of silently leaving the dialog open.
  const closeDelete = () => {
    setAuctionToDelete(null);
    deleteAuction.reset();
  };

  const handleDelete = async () => {
    if (!auctionToDelete) return;
    try {
      await deleteAuction.mutateAsync(auctionToDelete.id);
      closeDelete();
    } catch (error) {
      console.error('Failed to delete auction:', error);
    }
  };

  return (
    <div className="min-h-full bg-gray-100 dark:bg-gray-900">
      <div className="mx-auto max-w-[1120px] px-4 py-8 sm:px-6 sm:pb-16">
        <Button variant="outline" size="sm" className="mb-[18px] bg-white max-md:h-11" onClick={returnToDashboard}>
          <ArrowLeft className="h-4 w-4" />
          Back to dashboard
        </Button>
        <div className="mb-7">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h1 className="text-[22px] leading-[1.15] font-extrabold tracking-[-0.02em] text-gray-900 md:text-[26px] md:leading-[1.1] dark:text-white">
                Draft History
              </h1>
              <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
                Completed drafts you can review. Official league drafts are visible to every member; your mocks stay private to you.
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              className={`max-md:h-11 max-md:px-5 ${isEditing ? 'bg-gray-100 dark:bg-gray-800' : 'bg-white'}`}
              onClick={() => setIsEditing((v) => !v)}
            >
              {isEditing ? 'Done' : 'Edit'}
            </Button>
          </div>
        </div>

        {completedDrafts.length > 0 ? (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(min(330px,100%),1fr))] gap-4">
            {completedDrafts.map((auction) => (
              <Card key={auction.id} className="gap-0 rounded-[14px] py-0 shadow-sm transition hover:border-gray-300 hover:shadow-md">
                <CardContent className="flex h-full flex-col p-5">
                  <div className="mb-3 flex items-center gap-2">
                    <Badge
                      variant="secondary"
                      className={auction.type === 'official'
                        ? 'bg-blue-100 text-[10px] font-extrabold tracking-[0.06em] text-blue-700 dark:bg-blue-950/60 dark:text-blue-400'
                        : 'text-[10px] font-extrabold tracking-[0.06em] text-gray-600 dark:text-gray-300'}
                    >
                      {auction.type.toUpperCase()}
                    </Badge>
                    {auction.sim && (
                      <Badge className="border-0 bg-purple-100 text-[10px] font-bold text-purple-700 hover:bg-purple-100 dark:bg-purple-950/60 dark:text-purple-400">
                        SIMULATED
                      </Badge>
                    )}
                    <Badge variant="secondary" className="ml-auto rounded-full text-[11px] text-gray-600">
                      <Check className="h-3 w-3" />
                      Completed
                    </Badge>
                  </div>
                  <div className="text-[17px] font-bold tracking-[-0.01em] text-gray-900 dark:text-white">
                    {auction.name}
                  </div>
                  <div className="mt-1.5 text-[12.5px] text-gray-500 dark:text-gray-400">
                    Completed {formatDate(auction.updated)} · {auction.year ? `Season ${auction.year}` : 'Legacy'}
                  </div>
                  <div className="mt-4 flex gap-2">
                    <Button
                      variant="outline"
                      className="h-10 flex-1 bg-gray-50 font-bold text-blue-700 max-md:h-11 hover:border-blue-200 hover:bg-blue-50 hover:text-blue-800 dark:bg-gray-900 dark:text-blue-400"
                      onClick={() => setSelectedAuctionId(auction.id)}
                    >
                      <Eye className="h-4 w-4" />
                      Review Draft
                    </Button>
                    {isEditing && auction.user === userId && (
                      <Button
                        variant="outline"
                        size="icon"
                        className="h-10 w-10 shrink-0 max-md:size-11 text-red-600 border-red-200 hover:text-red-700 hover:bg-red-50 dark:text-red-400 dark:border-red-900"
                        onClick={() => setAuctionToDelete(auction)}
                        aria-label="Delete draft"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        ) : (
          <div className="rounded-2xl border border-dashed border-gray-300 bg-white px-6 py-14 text-center dark:border-gray-700 dark:bg-gray-950 sm:px-8">
            <div className="mx-auto mb-5 flex h-[60px] w-[60px] items-center justify-center rounded-2xl bg-gray-100 text-gray-400 dark:bg-gray-900">
              <History className="h-[30px] w-[30px]" />
            </div>
            <h2 className="text-[19px] font-bold text-gray-900 dark:text-white">No completed drafts yet</h2>
            <p className="mx-auto mt-2.5 max-w-[440px] text-pretty text-sm leading-[1.55] text-gray-500 dark:text-gray-400">
              Once a draft wraps, it lands here for review — final rosters, spend, and the full board, all read-only. Nothing&apos;s finished yet, so start one to get going.
            </p>
            <div className="mt-6 flex flex-wrap justify-center gap-3">
              <Button className="bg-neutral-900 hover:bg-neutral-700 max-md:h-11" onClick={() => openNewDraft('mock')}>
                <Dices className="h-4 w-4" />
                Start a mock draft
              </Button>
              {isCommissioner && (
                <Button className="bg-blue-700 hover:bg-blue-800 max-md:h-11" onClick={() => openNewDraft('official')}>
                  <Trophy className="h-4 w-4" />
                  Start an official draft
                </Button>
              )}
            </div>
          </div>
        )}
      </div>

      <NewAuctionModal
        isOpen={showNewDraft}
        onClose={() => setShowNewDraft(false)}
        initialType={newDraftType}
      />

      <Dialog open={!!auctionToDelete} onOpenChange={(open) => !open && closeDelete()}>
        <DialogContent variant="alert" className="max-w-md">
          <DialogHeader>
            <DialogTitle>Delete Draft</DialogTitle>
            <DialogDescription>
              {auctionToDelete
                ? `"${auctionToDelete.name}" will be permanently deleted. This cannot be undone.`
                : ''}
            </DialogDescription>
          </DialogHeader>
          {deleteAuction.error && (
            <p className="text-sm font-medium text-red-600 dark:text-red-400">
              {deleteAuction.error.message}
            </p>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={closeDelete}
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

function HighlightCard({
  kicker,
  pick,
  delta,
  amountClassName,
}: {
  kicker: string;
  pick: DraftPickWithDetails;
  delta: string;
  amountClassName: string;
}) {
  return (
    <Card className="gap-0 rounded-xl py-0 shadow-sm">
      <CardContent className="p-4">
        <div className="text-[10.5px] font-semibold uppercase tracking-[0.06em] text-gray-400">{kicker}</div>
        <div className="mt-2 flex items-center justify-between gap-2.5">
          <div className="flex min-w-0 items-center gap-2">
            <PositionLabel position={pick.player.position} />
            <span className="truncate text-[16.5px] font-bold tracking-[-0.01em] text-gray-900 dark:text-white">
              {pick.player.name}
            </span>
          </div>
          <span className={`shrink-0 text-[19px] font-extrabold tabular-nums md:text-[22px] ${amountClassName}`}>
            {pick.price == null ? '—' : `$${pick.price}`}
          </span>
        </div>
        <div className="mt-2 text-xs text-gray-500 dark:text-gray-400">{pick.team.name} · {delta}</div>
      </CardContent>
    </Card>
  );
}

function CompletedDraftDetail({ auction }: { auction: Auction }) {
  const { setSelectedAuctionId } = useAuction();
  const { data: picks = [], isLoading: picksLoading } = useAllDraftPicks();
  const { data: teams = [], isLoading: teamsLoading } = useAuctionTeams();
  const [tab, setTab] = useState<'board' | 'rosters'>('board');
  const [rosterView, setRosterView] = useState<RosterViewMode>('flat');

  const sortedTeams = useMemo(() => [...teams].sort((a, b) => a.draft_order - b.draft_order), [teams]);
  const picksByTeam = useMemo(() => {
    const grouped = new Map<string, DraftPickWithDetails[]>();
    for (const team of sortedTeams) grouped.set(team.id, []);
    for (const pick of picks) grouped.get(pick.fantasy_team_id)?.push(pick);
    for (const teamPicks of grouped.values()) teamPicks.sort((a, b) => a.pick_order - b.pick_order);
    return grouped;
  }, [picks, sortedTeams]);
  const maxTeamPicks = Math.max(0, ...sortedTeams.map((team) => picksByTeam.get(team.id)?.length ?? 0));

  const { priciest, biggestBargain, biggestOverpay } = useMemo(
    () => getDraftHighlights(picks),
    [picks],
  );
  if (picksLoading || teamsLoading) {
    return <div className="p-8 text-center text-sm text-gray-500">Loading completed draft…</div>;
  }

  return (
    <div className="min-h-full bg-gray-100 dark:bg-gray-900">
      <div className="mx-auto max-w-[1360px] px-4 py-5 sm:px-6 sm:pb-[72px]">
        <Button variant="outline" size="sm" className="mb-[18px] bg-white max-md:h-11" onClick={() => setSelectedAuctionId(null)}>
          <ArrowLeft className="h-4 w-4" />
          Back to Draft History
        </Button>

        <div className="mb-[22px] flex flex-wrap items-end justify-between gap-3.5">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-[21px] font-extrabold tracking-[-0.02em] text-gray-900 md:text-[25px] dark:text-white">{auction.name}</h1>
              <Badge className={auction.type === 'official' ? 'bg-blue-100 text-blue-700 hover:bg-blue-100' : 'bg-gray-200 text-gray-700 hover:bg-gray-200'}>
                {auction.type.toUpperCase()}
              </Badge>
              <Badge variant="secondary" className="rounded-full text-gray-600">
                <Check className="h-3 w-3" />
                Completed
              </Badge>
            </div>
            <p className="mt-2 text-[13.5px] text-gray-500 dark:text-gray-400">
              {auction.year ? `Season ${auction.year}` : 'Legacy'} · Completed {formatDate(auction.updated)} · {sortedTeams.length} teams
            </p>
          </div>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-200 bg-yellow-100 px-3 py-1.5 text-xs font-semibold text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
            <Lock className="h-3.5 w-3.5" />
            Read-only archive
          </span>
        </div>

        {priciest && (
          <>
            <h2 className="mb-3 text-[15px] font-bold text-gray-900 dark:text-white">Highlights</h2>
            <div className="mb-6 grid grid-cols-[repeat(auto-fit,minmax(min(250px,100%),1fr))] gap-3">
              <HighlightCard kicker="Priciest pick" pick={priciest} delta="Top winning bid" amountClassName="text-gray-900 dark:text-white" />
              {biggestBargain && (
                <HighlightCard
                  kicker="Biggest bargain"
                  pick={biggestBargain.pick}
                  delta={`$${biggestBargain.difference} under projection`}
                  amountClassName="text-green-600"
                />
              )}
              {biggestOverpay && (
                <HighlightCard
                  kicker="Biggest overpay"
                  pick={biggestOverpay.pick}
                  delta={`$${biggestOverpay.difference} over projection`}
                  amountClassName="text-amber-700"
                />
              )}
            </div>
          </>
        )}

        <div className="mb-3.5 flex flex-wrap items-center gap-3">
          <div className="inline-flex gap-1 rounded-[10px] bg-gray-200 p-1 max-md:w-full dark:bg-gray-800">
            <Button size="sm" variant={tab === 'board' ? 'outline' : 'ghost'} className="h-8 max-md:h-11 max-md:flex-1" onClick={() => setTab('board')}>
              Draft Board
            </Button>
            <Button size="sm" variant={tab === 'rosters' ? 'outline' : 'ghost'} className="h-8 max-md:h-11 max-md:flex-1" onClick={() => setTab('rosters')}>
              Team Rosters
            </Button>
          </div>
          <span className="text-xs text-gray-400">
            {tab === 'board' ? `${sortedTeams.length} teams · ${maxTeamPicks} rounds · read-only` : 'In draft order'}
          </span>
          {tab === 'rosters' && (
            <RosterViewToggle view={rosterView} onChange={setRosterView} />
          )}
        </div>

        {tab === 'board' ? (
          <DraftBoard embedded />
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(min(300px,100%),1fr))] gap-3.5">
            {sortedTeams.map((team) => (
              <TeamRosterCard
                key={team.id}
                team={team}
                draftPicks={picksByTeam.get(team.id) ?? []}
                view={rosterView}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function DraftHistoryView() {
  const { selectedAuction } = useAuction();

  if (selectedAuction?.status === 'completed') {
    return <CompletedDraftDetail auction={selectedAuction} />;
  }

  return <DraftHistoryList />;
}
