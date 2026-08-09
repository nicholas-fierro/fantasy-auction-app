'use client';

import { useState } from 'react';
import { PencilLine, Check, X, Trash2 } from 'lucide-react';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  useAllDraftPicks,
  useUpdateDraftPickPrice,
  useDeleteDraftPick,
} from '@/hooks/use-draft-picks';
import type { DraftPickWithDetails } from '@/server/types/draft-pick';

const MAX_ROWS = 10;

function pickRecency(pick: DraftPickWithDetails): number {
  const timestamp = Date.parse(pick.timestamp);
  if (Number.isFinite(timestamp)) return timestamp;
  const created = Date.parse(pick.created);
  return Number.isFinite(created) ? created : pick.pick_order;
}

function formatWhen(pick: DraftPickWithDetails): string {
  const iso = pick.timestamp || pick.created;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  const diffSeconds = Math.round((Date.now() - ms) / 1000);
  if (diffSeconds < 60) return 'just now';
  if (diffSeconds < 3600) return `${Math.floor(diffSeconds / 60)}m ago`;
  if (diffSeconds < 86400) return `${Math.floor(diffSeconds / 3600)}h ago`;
  return new Date(ms).toLocaleDateString();
}

// One editable row: inline price edit (Enter/check to save, Esc/x to cancel)
// and a two-step delete. Both go through the existing draft-pick mutations,
// which the PB API rule already gates to an active auction (AD-10).
function CorrectionRow({ pick }: { pick: DraftPickWithDetails }) {
  const updatePrice = useUpdateDraftPickPrice();
  const deletePick = useDeleteDraftPick();
  const [editing, setEditing] = useState(false);
  const [draftPrice, setDraftPrice] = useState('');
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const startEditing = () => {
    setDraftPrice(pick.price != null ? String(pick.price) : '');
    setEditing(true);
  };

  const savePrice = async () => {
    const trimmed = draftPrice.trim();
    const nextPrice = trimmed === '' ? null : Number(trimmed);
    if (nextPrice != null && !Number.isFinite(nextPrice)) return;
    if (nextPrice !== pick.price) {
      try {
        await updatePrice.mutateAsync({ id: pick.id, price: nextPrice });
      } catch (error) {
        console.error('Failed to update pick price:', error);
        return;
      }
    }
    setEditing(false);
  };

  const handleDelete = async () => {
    try {
      await deletePick.mutateAsync(pick.id);
    } catch (error) {
      console.error('Failed to delete pick:', error);
      setConfirmingDelete(false);
    }
  };

  return (
    <div className="flex items-center gap-2 rounded-md border border-gray-200 px-3 py-2 text-sm dark:border-gray-800 max-md:px-2">
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium text-gray-900 dark:text-gray-100">
          {pick.player.name}
          <span className="ml-1.5 text-xs font-normal text-gray-500">{pick.player.position}</span>
        </div>
        <div className="truncate text-xs text-gray-500">
          {pick.team.name} · {formatWhen(pick)}
        </div>
      </div>

      {editing ? (
        <div className="flex shrink-0 items-center gap-1">
          <span className="text-gray-500">$</span>
          <Input
            type="number"
            inputMode="numeric"
            value={draftPrice}
            autoFocus
            onChange={(e) => setDraftPrice(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void savePrice();
              if (e.key === 'Escape') setEditing(false);
            }}
            className="h-8 w-20 max-md:h-10 max-md:w-16"
          />
          <Button
            size="sm"
            variant="ghost"
            className="h-8 w-8 p-0 max-md:h-10 max-md:w-10 text-emerald-600"
            onClick={() => void savePrice()}
            disabled={updatePrice.isPending}
            aria-label="Save price"
          >
            <Check className="h-4 w-4" />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-8 w-8 p-0 max-md:h-10 max-md:w-10 text-gray-500"
            onClick={() => setEditing(false)}
            aria-label="Cancel price edit"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      ) : (
        <button
          type="button"
          onClick={startEditing}
          className="group flex items-center gap-1 rounded px-2 py-1 font-semibold tabular-nums text-gray-900 hover:bg-gray-100 dark:text-gray-100 dark:hover:bg-gray-800"
          title="Edit price"
        >
          {pick.price != null ? `$${pick.price}` : '—'}
          <PencilLine className="h-3 w-3 opacity-0 group-hover:opacity-60" />
        </button>
      )}

      {confirmingDelete ? (
        <div className="flex items-center gap-1">
          <Button
            size="sm"
            variant="destructive"
            className="h-8 max-md:h-10"
            onClick={() => void handleDelete()}
            disabled={deletePick.isPending}
          >
            {deletePick.isPending ? '…' : 'Remove'}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-8 w-8 p-0 max-md:h-10 max-md:w-10 text-gray-500"
            onClick={() => setConfirmingDelete(false)}
            aria-label="Cancel delete"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      ) : (
        <Button
          size="sm"
          variant="ghost"
          className="h-8 w-8 p-0 max-md:h-10 max-md:w-10 text-red-500 hover:text-red-600"
          onClick={() => setConfirmingDelete(true)}
          aria-label={`Delete ${pick.player.name}`}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      )}
    </div>
  );
}

// 3c: commissioner-lane correction panel. Lists the most recent picks with
// inline price edits and delete+confirm. Rendered only for the admin lane on an
// active, editable auction (see AuctionSwitcherBar); the PB rules are the real
// guard.
export function PickCorrectionsSheet() {
  const { data: picks = [] } = useAllDraftPicks();
  const [open, setOpen] = useState(false);

  const recentPicks = [...picks].sort((a, b) => pickRecency(b) - pickRecency(a)).slice(0, MAX_ROWS);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="outline" size="sm">
          <PencilLine className="mr-1 h-4 w-4" />
          Corrections
        </Button>
      </SheetTrigger>
      <SheetContent className="w-full md:max-w-md">
        <SheetHeader>
          <SheetTitle>Recent picks</SheetTitle>
          <SheetDescription>
            Fix a price or remove a mistaken pick from the last {MAX_ROWS} entries. Changes are
            immediate and visible to everyone in the draft.
          </SheetDescription>
        </SheetHeader>
        <div className="mt-4 flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-4 pb-6">
          {recentPicks.length === 0 ? (
            <p className="px-1 py-6 text-center text-sm text-gray-500">No picks recorded yet.</p>
          ) : (
            recentPicks.map((pick) => <CorrectionRow key={pick.id} pick={pick} />)
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
