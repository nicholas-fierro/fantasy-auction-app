'use client';

import { useState } from 'react';
import { ArrowRight, Dices, History, Trophy } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { NewAuctionModal } from '@/components/new-auction-modal';
import { useAuction } from '@/contexts/auction-context';
import { useNavigation } from '@/contexts/navigation-context';
import { useIsCommissioner } from '@/hooks/use-league';

export function NoActiveDraftLanding() {
  const { accessibleActiveAuctions } = useAuction();
  const { setCurrentView, setLandingOverride, enterDraftRoom } = useNavigation();
  const isCommissioner = useIsCommissioner();
  const [newDraftType, setNewDraftType] = useState<'official' | 'mock'>('mock');
  const [showNewDraft, setShowNewDraft] = useState(false);

  const openNewDraft = (type: 'official' | 'mock') => {
    setNewDraftType(type);
    setShowNewDraft(true);
  };

  const browseHistory = () => {
    setLandingOverride(false);
    setCurrentView('draft-history');
  };

  return (
    <div className="min-h-full bg-gray-100 dark:bg-gray-900">
      <div className="mx-auto max-w-[1120px] px-4 py-10 max-md:py-6 sm:px-6 sm:pb-16">
        <div className="mb-8 max-w-[620px] sm:mb-[34px]">
          <div className="mb-2.5 text-[11px] font-bold tracking-[0.16em] text-gray-500">
            DRAFT HELPER
          </div>
          <h1 className="text-balance text-[32px] font-extrabold leading-[1.1] tracking-[-0.02em] text-gray-900 dark:text-white max-md:text-[26px]">
            Welcome back to Draft Helper
          </h1>
          <p className="mt-3 text-pretty text-[15.5px] leading-[1.55] text-gray-500 dark:text-gray-400">
            {accessibleActiveAuctions.length > 0
              ? 'You’re all caught up here. Jump back into a draft room that’s currently running, spin up a fresh mock to sharpen your strategy, or revisit the results of a completed draft.'
              : 'You’re all caught up — nothing is live for you right now. Spin up a fresh mock to sharpen your strategy, or revisit the results of a completed draft.'}
          </p>
        </div>

        {accessibleActiveAuctions.length > 0 && (
          <>
            <div className="mb-3.5 flex flex-wrap items-center gap-2">
              <span className="relative h-[9px] w-[9px]">
                <span className="absolute inset-0 rounded-full bg-emerald-500" />
                <span className="absolute -inset-[3px] rounded-full bg-emerald-500/30" />
              </span>
              <h2 className="text-[15px] font-bold text-gray-900 dark:text-white">
                Live now — jump back in
              </h2>
              <span className="text-[12.5px] text-gray-400">
                {accessibleActiveAuctions.length} draft{accessibleActiveAuctions.length === 1 ? '' : 's'} you can enter
              </span>
            </div>

              <div className="mb-10 grid grid-cols-[repeat(auto-fill,minmax(min(340px,100%),1fr))] gap-4">
                {accessibleActiveAuctions.map((auction) => (
                  <Card
                    key={auction.id}
                    className="relative gap-0 overflow-hidden rounded-[14px] py-0 shadow-sm"
                  >
                    <span
                      className={auction.type === 'official'
                        ? 'absolute inset-y-0 left-0 w-1 bg-emerald-600'
                        : 'absolute inset-y-0 left-0 w-1 bg-indigo-500'}
                    />
                    <CardContent className="p-5 pl-[22px]">
                      <div className="mb-3 flex items-center gap-2">
                        <Badge className="border-0 bg-emerald-100 text-[10px] font-extrabold tracking-[0.08em] text-emerald-700 hover:bg-emerald-100 dark:bg-emerald-950/60 dark:text-emerald-400">
                          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                          LIVE
                        </Badge>
                        <Badge
                          variant="secondary"
                          className={auction.type === 'official'
                            ? 'bg-blue-100 text-[10px] font-extrabold tracking-[0.06em] text-blue-700 dark:bg-blue-950/60 dark:text-blue-400'
                            : 'text-[10px] font-extrabold tracking-[0.06em] text-gray-600 dark:text-gray-300'}
                        >
                          {auction.type.toUpperCase()}
                        </Badge>
                        <span className="ml-auto text-xs font-medium text-gray-400">
                          {auction.year ? `Season ${auction.year}` : 'Legacy'}
                        </span>
                      </div>
                      <div className="text-lg font-bold tracking-[-0.01em] text-gray-900 dark:text-white">
                        {auction.name}
                      </div>
                      <div className="mt-1 text-[13px] text-gray-500 dark:text-gray-400">
                        Draft in progress
                      </div>
                      <div className="mt-3 rounded-[9px] border border-gray-100 bg-gray-50 px-3 py-2.5 text-[12.5px] text-gray-600 dark:border-gray-800 dark:bg-gray-900 dark:text-gray-300">
                        {auction.type === 'official'
                          ? 'Your league’s live draft room is open.'
                          : auction.sim
                            ? 'AI simulated · waiting for your next move.'
                            : 'Your private mock draft is ready to continue.'}
                      </div>
                      <Button
                        className="mt-4 h-[42px] w-full bg-emerald-600 text-sm font-bold shadow-sm hover:bg-emerald-700 max-md:h-11"
                        onClick={() => enterDraftRoom(auction.id)}
                      >
                        Enter Draft Room
                        <ArrowRight className="h-[17px] w-[17px]" />
                      </Button>
                    </CardContent>
                  </Card>
                ))}
              </div>
          </>
        )}

        <h2 className="mb-3.5 text-[15px] font-bold text-gray-900 dark:text-white">Get started</h2>
        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(300px,100%),1fr))] gap-4">
          <Card className="gap-0 rounded-[14px] py-0 shadow-sm">
            <CardContent className="flex h-full flex-col p-[22px]">
              <div className="mb-3.5 flex h-[42px] w-[42px] items-center justify-center rounded-[11px] bg-indigo-50 text-indigo-600 dark:bg-indigo-950/50 dark:text-indigo-400">
                <Dices className="h-[22px] w-[22px]" />
              </div>
              <div className="text-base font-bold text-gray-900 dark:text-white">Start a mock draft</div>
              <p className="mb-[18px] mt-1.5 flex-1 text-[13px] leading-5 text-gray-500 dark:text-gray-400">
                Throwaway what-ifs to rehearse your board. Mock prices never touch your historical analysis.
              </p>
              <Button className="h-[38px] self-start bg-neutral-900 px-4 text-[13.5px] hover:bg-neutral-700 max-md:h-11 max-md:w-full" onClick={() => openNewDraft('mock')}>
                <Dices className="h-4 w-4" />
                Start mock draft
              </Button>
            </CardContent>
          </Card>

          {isCommissioner && (
            <Card className="gap-0 rounded-[14px] border-blue-100 bg-gradient-to-b from-blue-50 to-white py-0 shadow-sm dark:border-blue-900 dark:from-blue-950/40 dark:to-gray-950">
              <CardContent className="flex h-full flex-col p-[22px]">
                <div className="mb-3.5 flex h-[42px] w-[42px] items-center justify-center rounded-[11px] bg-blue-100 text-blue-700 dark:bg-blue-950/60 dark:text-blue-400">
                  <Trophy className="h-[22px] w-[22px]" />
                </div>
                <div className="flex items-center gap-2">
                  <div className="text-base font-bold text-gray-900 dark:text-white">Start an official draft</div>
                  <Badge className="border-0 bg-blue-100 text-[9.5px] font-extrabold tracking-[0.06em] text-blue-700 hover:bg-blue-100 dark:bg-blue-950/60 dark:text-blue-400">
                    COMMISH
                  </Badge>
                </div>
                <p className="mb-[18px] mt-1.5 flex-1 text-[13px] leading-5 text-gray-500 dark:text-gray-400">
                  Kick off the real thing for your league. Official prices feed everyone&apos;s history and the value model.
                </p>
                <Button className="h-[38px] self-start bg-blue-700 px-4 text-[13.5px] hover:bg-blue-800 max-md:h-11 max-md:w-full" onClick={() => openNewDraft('official')}>
                  <Trophy className="h-4 w-4" />
                  Start official draft
                </Button>
              </CardContent>
            </Card>
          )}

          <Card className="gap-0 rounded-[14px] py-0 shadow-sm">
            <CardContent className="flex h-full flex-col p-[22px]">
              <div className="mb-3.5 flex h-[42px] w-[42px] items-center justify-center rounded-[11px] bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                <History className="h-[22px] w-[22px]" />
              </div>
              <div className="text-base font-bold text-gray-900 dark:text-white">Review past drafts</div>
              <p className="mb-[18px] mt-1.5 flex-1 text-[13px] leading-5 text-gray-500 dark:text-gray-400">
                Open any completed official or mock draft to study final rosters, spend, and the full board.
              </p>
              <Button variant="outline" className="h-[38px] self-start px-4 text-[13.5px] max-md:h-11 max-md:w-full" onClick={browseHistory}>
                Browse Draft History
                <ArrowRight className="h-4 w-4" />
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>

      <NewAuctionModal
        isOpen={showNewDraft}
        onClose={() => setShowNewDraft(false)}
        initialType={newDraftType}
      />
    </div>
  );
}
