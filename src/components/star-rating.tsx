'use client';

import { Star } from 'lucide-react';
import { cn } from '@/lib/utils';

interface StarRatingProps {
  value: number;
  maxStars?: number;
  className?: string;
}

export function StarRating({ value, maxStars = 5, className }: StarRatingProps) {
  const normalizedValue = Math.max(0, Math.min(value, maxStars));

  return (
    <div className={cn("flex items-center space-x-0.5", className)}>
      {Array.from({ length: maxStars }, (_, index) => {
        const starValue = index + 1;
        const isFilled = normalizedValue >= starValue;
        const isPartial = normalizedValue > index && normalizedValue < starValue;

        return (
          <Star
            key={index}
            className={cn(
              "h-3 w-3",
              isFilled
                ? "fill-yellow-400 text-yellow-400"
                : isPartial
                ? "fill-yellow-200 text-yellow-400"
                : "fill-none text-gray-300"
            )}
          />
        );
      })}
    </div>
  );
}
