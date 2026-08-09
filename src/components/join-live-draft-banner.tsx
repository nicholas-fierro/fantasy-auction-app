'use client';

import { Radio } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useNavigation } from '@/contexts/navigation-context';
import { useJoinableAuctions } from '@/hooks/use-joinable-auctions';

// 3a: nudge a league member toward a live official draft they're not
// currently viewing (e.g. they opened the app on a mock or a past auction
// while the commissioner started the real one). Skips the auction's owner —
// they already know it's running.
export function JoinLiveDraftBanner() {
  const { enterDraftRoom } = useNavigation();
  const joinableAuctions = useJoinableAuctions();

  if (joinableAuctions.length === 0) return null;

  return (
    <div className="mb-3 flex flex-col gap-2">
      {joinableAuctions.map((auction) => (
        <div
          key={auction.id}
          className="flex flex-wrap items-center gap-2 rounded-lg border border-purple-300 bg-purple-50 px-4 py-2.5 text-sm font-medium text-purple-800 dark:border-purple-800 dark:bg-purple-950/40 dark:text-purple-300"
        >
          <Radio className="h-4 w-4 shrink-0 animate-pulse" />
          <span className="flex-1">
            &ldquo;{auction.name}&rdquo; is live right now
          </span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-11 shrink-0 sm:h-7 border-purple-400 bg-white text-purple-800 hover:bg-purple-100 dark:border-purple-700 dark:bg-transparent dark:text-purple-300 dark:hover:bg-purple-950/60"
            onClick={() => enterDraftRoom(auction.id)}
          >
            Switch to it
          </Button>
        </div>
      ))}
    </div>
  );
}
