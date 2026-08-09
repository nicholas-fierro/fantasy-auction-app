'use client';

import { useState } from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Check, X, Edit3, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

interface EditableAuctionValueProps {
  value: number | null;
  onSave: (value: number | null) => void;
  isLoading?: boolean;
  placeholder?: string;
  className?: string;
  variant?: 'default' | 'price-cluster';
  /** Below md the value renders read-only — editing happens in the player modal instead. */
  hideEditOnMobile?: boolean;
}

export function EditableAuctionValue({
  value,
  onSave,
  isLoading = false,
  placeholder = "Enter value",
  className,
  variant = 'default',
  hideEditOnMobile = false
}: EditableAuctionValueProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [inputValue, setInputValue] = useState(value?.toString() || '');

  const handleSave = () => {
    const numValue = inputValue.trim() === '' ? null : Number(inputValue);
    if (inputValue.trim() !== '' && (isNaN(numValue!) || numValue! < 0)) {
      return; // Invalid input
    }
    onSave(numValue);
    setIsEditing(false);
  };

  const handleCancel = () => {
    setInputValue(value?.toString() || '');
    setIsEditing(false);
  };

  const handleEdit = () => {
    setInputValue(value?.toString() || '');
    setIsEditing(true);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSave();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      handleCancel();
    }
  };

  if (variant === 'price-cluster') {
    return (
      <div className={cn("flex flex-col gap-0.5 pb-1", className)}>
        <span className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
          Proj
        </span>
        <span className="flex items-center gap-1.5">
          {isEditing ? (
            <span className="flex min-h-7 items-center border-b-2 border-violet-600 text-xl font-medium leading-none tabular-nums max-md:min-h-11">
              $
              <Input
                type="number"
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                onKeyDown={handleKeyDown}
                onBlur={handleSave}
                onFocus={(e) => e.currentTarget.select()}
                aria-label={placeholder}
                data-price-editor
                className="h-auto w-11 rounded-none border-0 bg-transparent px-0 py-0 text-xl font-medium leading-none tabular-nums shadow-none transition-none focus-visible:ring-0"
                min="0"
                step="1"
                inputMode="numeric"
                autoFocus
                disabled={isLoading}
              />
            </span>
          ) : (
            <button
              type="button"
              onClick={handleEdit}
              disabled={isLoading}
              aria-label={`Edit ${placeholder}`}
              className="min-h-7 border-b border-dashed border-zinc-300 text-xl font-medium leading-none text-zinc-600 tabular-nums hover:border-violet-600 hover:text-foreground focus-visible:border-violet-600 focus-visible:text-foreground focus-visible:outline-none disabled:cursor-wait disabled:text-muted-foreground max-md:min-h-11 max-md:px-1"
            >
              {value !== null ? `$${value}` : '—'}
            </button>
          )}
          {isLoading && <Loader2 className="size-3 animate-spin text-violet-600" />}
        </span>
      </div>
    );
  }

  if (isEditing) {
    return (
      <div className={cn("flex items-center gap-1", className)}>
        <Input
          type="number"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          className="w-20 h-8 text-sm transition-none max-md:h-11 max-md:text-base"
          min="0"
          step="1"
          inputMode="numeric"
          autoFocus
          disabled={isLoading}
        />
        <Button
          size="sm"
          variant="ghost"
          onClick={handleSave}
          disabled={isLoading}
          className="h-8 w-8 p-0 transition-none max-md:size-11"
        >
          <Check className="h-4 w-4 text-green-600" />
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={handleCancel}
          disabled={isLoading}
          className="h-8 w-8 p-0 transition-none max-md:size-11"
        >
          <X className="h-4 w-4 text-red-600" />
        </Button>
      </div>
    );
  }

  return (
    <div className={cn("flex items-center gap-2 group", className)}>
      <span className="text-sm font-medium min-w-[2rem]">
        {value !== null ? `$${value}` : '-'}
      </span>
      {isLoading ? (
        <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
      ) : (
        // No hover on touch — the pencil is always visible below md.
        <Button
          size="sm"
          variant="ghost"
          onClick={handleEdit}
          className={cn(
            "h-6 w-6 p-0 opacity-0 group-hover:opacity-100 transition-none max-md:h-11 max-md:w-7 max-md:opacity-100",
            hideEditOnMobile && "max-md:hidden"
          )}
          disabled={isLoading}
        >
          <Edit3 className="h-3 w-3" />
        </Button>
      )}
    </div>
  );
}