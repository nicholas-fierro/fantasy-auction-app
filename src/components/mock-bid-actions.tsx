'use client';

import type { MouseEvent } from 'react';
import { Button } from '@/components/ui/button';
import { markBidPoint } from '@/components/win-confetti';
import { getMockBidState } from '@/lib/mock-draft/bid-state';
import { cn } from '@/lib/utils';

interface MockBidActionsProps {
  pending: { price: number; uncontested: boolean };
  userMaxBid: number;
  onPass: () => void;
  onBid: () => void;
  disabled?: boolean;
  compact?: boolean;
  className?: string;
}

export function MockBidActions({
  pending,
  userMaxBid,
  onPass,
  onBid,
  disabled = false,
  compact = false,
  className,
}: MockBidActionsProps) {
  const { minBid, canCounter } = getMockBidState(pending, userMaxBid);
  const bid = (event: MouseEvent<HTMLButtonElement>) => {
    markBidPoint(event.currentTarget);
    onBid();
  };
  const buttonClass = compact
    ? 'h-[30px] rounded-[7px] text-xs whitespace-nowrap'
    : 'h-11 flex-1 px-2 text-xs';

  if (pending.uncontested) {
    return (
      <Button
        type="button"
        onClick={bid}
        disabled={disabled}
        title={disabled ? 'Resume simulation to continue' : undefined}
        className={cn(buttonClass, 'bg-green-700 text-white hover:bg-green-800', className)}
      >
        Draft for ${pending.price}
      </Button>
    );
  }

  return (
    <div className={cn('flex gap-2', compact ? 'flex-none' : 'flex-1', className)}>
      <Button
        type="button"
        variant="outline"
        onClick={onPass}
        disabled={disabled}
        title={disabled ? 'Resume simulation to continue' : undefined}
        className={buttonClass}
      >
        Pass
      </Button>
      <Button
        type="button"
        onClick={bid}
        disabled={disabled || !canCounter}
        title={
          disabled
            ? 'Resume simulation to continue'
            : !canCounter
              ? 'Not enough budget to counter'
              : undefined
        }
        className={cn(buttonClass, 'bg-green-700 text-white hover:bg-green-800')}
      >
        Bid ${minBid}
      </Button>
    </div>
  );
}
