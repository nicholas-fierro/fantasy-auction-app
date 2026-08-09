'use client';

import { useEffect, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { DraftComparePanel } from '@/components/draft-compare-panel';
import type { Player } from '@/server/types/player';

interface PlayerCompareModalProps {
  initialPlayer: Player;
  isOpen: boolean;
  onClose: () => void;
}

export function PlayerCompareModal({ initialPlayer, isOpen, onClose }: PlayerCompareModalProps) {
  const [selectedIds, setSelectedIds] = useState<[string | null, string | null]>([initialPlayer.id, null]);

  useEffect(() => {
    setSelectedIds([initialPlayer.id, null]);
  }, [initialPlayer.id]);

  const select = (slot: 0 | 1, player: Player) => {
    setSelectedIds((current) => slot === 0 ? [player.id, current[1]] : [current[0], player.id]);
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent
        aria-describedby={undefined}
        className="flex flex-col gap-0 overflow-hidden md:max-h-[88dvh] md:max-w-3xl md:rounded-2xl md:p-0"
      >
        <DialogHeader className="z-10 shrink-0 border-b bg-background py-4 pl-5 pr-12 md:pl-6">
          <DialogTitle className="flex min-w-0 items-center gap-3 text-left">
            <span className="truncate text-lg">Who Should I Draft?</span>
          </DialogTitle>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto p-3 md:p-5">
          <DraftComparePanel variant="modal" selectedIds={selectedIds} onSelect={select} />
        </div>
      </DialogContent>
    </Dialog>
  );
}
