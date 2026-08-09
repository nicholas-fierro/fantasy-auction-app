'use client';

import { DraftBoard } from '@/components/draft-board';

export function DraftBoardView() {
  return (
    <div className="flex h-full flex-col">
      {/* Below md the board owns the vertical scroll (so its team header row and
          round column can stick); at md+ this stays the scroller as before. */}
      <div className="min-h-0 flex-1 overflow-auto max-md:flex max-md:flex-col max-md:overflow-hidden">
        <DraftBoard />
      </div>
    </div>
  );
}
