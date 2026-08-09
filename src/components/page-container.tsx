import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

/** Keeps the outer gutters consistent across every authenticated view. */
export function PageContainer({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      className={cn('p-4 sm:p-6', className)}
      {...props}
    />
  );
}
