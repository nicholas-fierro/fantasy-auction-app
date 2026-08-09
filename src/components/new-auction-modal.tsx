'use client';

import { useState, useEffect, useRef } from 'react';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical, TriangleAlert, Shuffle } from 'lucide-react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { FantasyTeam } from '@/server/types/fantasy-team';
import { useAllFantasyTeams } from '@/hooks/use-fantasy-teams';
import { useCreateAuction, useReplaceAuction } from '@/hooks/use-auctions';
import { useAuction } from '@/contexts/auction-context';
import { useIsCommissioner } from '@/hooks/use-league';
import { pb } from '@/lib/pb-client';
import { cn } from '@/lib/utils';
import type { Auction } from '@/server/types/auction';

interface SortableTeamItemProps {
  team: FantasyTeam;
  index: number;
}

function SortableTeamItem({ team, index }: SortableTeamItemProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: team.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        "flex items-center gap-3 p-2 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg",
        isDragging && "opacity-50 shadow-lg"
      )}
    >
      {/* touch-none is required for dnd-kit's PointerSensor to drag on a touch
          screen; the max-md padding widens the grab target to 44px without
          changing the row height (the negative margin absorbs it). */}
      <div
        {...attributes}
        {...listeners}
        className="cursor-grab touch-none active:cursor-grabbing text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 max-md:-my-2 max-md:py-3"
      >
        <GripVertical className="h-5 w-5" />
      </div>

      <div className="flex items-center justify-between flex-1">
        <div className="font-medium text-gray-900 dark:text-white">
          {team.name}
        </div>
        <div className="bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-400 px-3 py-1 rounded-full text-sm font-semibold">
          #{index + 1}
        </div>
      </div>
    </div>
  );
}

interface NewAuctionModalProps {
  isOpen: boolean;
  onClose: () => void;
  initialType?: 'official' | 'mock';
}

export function NewAuctionModal({ isOpen, onClose, initialType = 'mock' }: NewAuctionModalProps) {
  const currentYear = new Date().getFullYear();
  const [name, setName] = useState(`${currentYear} Draft`);
  const [year, setYear] = useState(String(currentYear));
  const [type, setType] = useState<'official' | 'mock'>('mock');
  const [sim, setSim] = useState(false);
  const [orderedTeams, setOrderedTeams] = useState<FantasyTeam[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [conflictingAuction, setConflictingAuction] = useState<Auction | null>(null);
  const wasOpen = useRef(false);

  const { auctions } = useAuction();
  const isCommissioner = useIsCommissioner();
  const { data: teams = [] } = useAllFantasyTeams();
  const createAuction = useCreateAuction();
  const replaceAuction = useReplaceAuction();

  const parsedYear = parseInt(year, 10);
  const isYearValid = !isNaN(parsedYear);
  const currentUserId = pb.authStore.record?.id;
  const sameTypeActiveAuction = auctions.find(
    (auction) =>
      auction.status === 'active' &&
      auction.type === type &&
      auction.user === currentUserId
  ) ?? null;
  const existingOfficialForYear =
    isYearValid && type === 'official'
      ? auctions.find(auction => auction.type === 'official' && auction.year === parsedYear) ?? null
      : null;

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  // Reset only on an open transition, so an async commissioner check cannot
  // discard choices made while the dialog is already open.
  useEffect(() => {
    if (isOpen && !wasOpen.current) {
      setName(`${currentYear} Draft`);
      setYear(String(currentYear));
      setType(initialType === 'official' && isCommissioner ? 'official' : 'mock');
      setSim(false);
      setOrderedTeams([]);
      setConflictingAuction(null);
    }
    wasOpen.current = isOpen;
  }, [isOpen, currentYear, initialType, isCommissioner]);

  useEffect(() => {
    if (!isCommissioner && type === 'official') {
      setType('mock');
    }
  }, [isCommissioner, type]);

  // Populate draft order when teams become available, while preserving any
  // ordering the user has already established in this open modal.
  useEffect(() => {
    if (!isOpen || teams.length === 0) return;
    setOrderedTeams((current) =>
      current.length > 0
        ? current
        : [...teams].sort((a, b) => a.draft_order - b.draft_order)
    );
  }, [isOpen, teams]);

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;

    if (active.id !== over?.id) {
      setOrderedTeams((items) => {
        const oldIndex = items.findIndex((item) => item.id === active.id);
        const newIndex = items.findIndex((item) => item.id === over?.id);

        return arrayMove(items, oldIndex, newIndex);
      });
    }
  }

  function handleRandomize() {
    setOrderedTeams((current) => {
      const shuffled = [...current];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      return shuffled;
    });
  }

  const auctionInput = () => ({
    name: name.trim(),
    year: parsedYear,
    type,
    sim: type === 'mock' ? sim : false,
    teamOrder: orderedTeams.map((team, index) => ({
      fantasy_team_id: team.id,
      draft_order: index + 1,
    })),
  });

  const createNewAuction = async () => {
    setIsLoading(true);
    try {
      await createAuction.mutateAsync(auctionInput());
      setConflictingAuction(null);
      onClose();
    } catch (error) {
      console.error('Failed to create auction:', error);
      toast.error(error instanceof Error ? error.message : 'Failed to create auction');
    } finally {
      setIsLoading(false);
    }
  };

  const handleSubmit = () => {
    if (!name.trim() || !isYearValid || orderedTeams.length === 0) return;
    if (type === 'official' && !isCommissioner) return;

    if (sameTypeActiveAuction) {
      setConflictingAuction(sameTypeActiveAuction);
      return;
    }

    void createNewAuction();
  };

  const resolveConflictAndCreate = async (resolution: 'complete' | 'delete') => {
    if (!conflictingAuction) return;

    setIsLoading(true);
    try {
      await replaceAuction.mutateAsync({
        activeId: conflictingAuction.id,
        input: auctionInput(),
        resolution,
      });
      setConflictingAuction(null);
      onClose();
    } catch (error) {
      console.error('Failed to replace active auction:', error);
      toast.error(error instanceof Error ? error.message : 'Failed to start auction');
    } finally {
      setIsLoading(false);
    }
  };

  const closeConflictConfirmation = () => {
    if (!isLoading) setConflictingAuction(null);
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="flex flex-col overflow-hidden md:max-h-[85dvh] md:max-w-md">
        <DialogHeader className="shrink-0 text-left max-md:pt-4 max-md:pr-12 max-md:pl-4">
          <DialogTitle>New Auction</DialogTitle>
          <DialogDescription>
            Set a name and the draft order for the new auction.
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex flex-1 flex-col gap-4 overflow-y-auto max-md:px-4 md:overflow-hidden">
          {sameTypeActiveAuction && (
            <div className="flex items-start gap-2.5 p-3 rounded-md border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 text-amber-900 dark:text-amber-300 text-sm">
              <TriangleAlert className="h-4 w-4 mt-0.5 shrink-0" />
              <div>
                <span className="font-semibold">&quot;{sameTypeActiveAuction.name}&quot; is still active.</span>{' '}
                Choose whether to save it to history or delete it before starting another {type} draft.
              </div>
            </div>
          )}

          <div className="space-y-4 py-2">
          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2 space-y-2">
              <Label htmlFor="auction-name">Name</Label>
              <Input
                id="auction-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={`${currentYear} Draft`}
                className="max-md:h-11"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="auction-year">Year</Label>
              <Input
                id="auction-year"
                type="number"
                inputMode="numeric"
                value={year}
                onChange={(e) => setYear(e.target.value)}
                className={cn("max-md:h-11", !isYearValid && "border-red-400 focus-visible:ring-red-400")}
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label>Type</Label>
            <div className={cn("grid gap-2", isCommissioner ? "grid-cols-2" : "grid-cols-1")}>
              <Button
                type="button"
                variant={type === 'mock' ? 'default' : 'outline'}
                onClick={() => setType('mock')}
                className="justify-center max-md:h-11"
              >
                Mock
              </Button>
              {isCommissioner && (
                <Button
                  type="button"
                  variant={type === 'official' ? 'default' : 'outline'}
                  onClick={() => setType('official')}
                  className="justify-center max-md:h-11"
                >
                  Official
                </Button>
              )}
            </div>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              {type === 'official'
                ? 'Official prices become trusted historical data used to estimate future costs.'
                : 'Mock auctions are throwaway what-ifs — their prices never feed analysis.'}
            </p>
          </div>

          {type === 'mock' && (
            <div className="space-y-2">
              <Label>Opponents</Label>
              <div className="grid grid-cols-2 gap-2">
                <Button
                  type="button"
                  variant={!sim ? 'default' : 'outline'}
                  onClick={() => setSim(false)}
                  className="justify-center max-md:h-11"
                >
                  Manual
                </Button>
                <Button
                  type="button"
                  variant={sim ? 'default' : 'outline'}
                  onClick={() => setSim(true)}
                  className="justify-center max-md:h-11"
                >
                  Simulated (AI)
                </Button>
              </div>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                {sim
                  ? 'You draft your team; the app plays the other 11 teams using their historical tendencies.'
                  : 'You record every pick yourself, as usual.'}
              </p>
            </div>
          )}

          {existingOfficialForYear && (
            <div className="flex items-start gap-2.5 p-3 rounded-md border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 text-amber-900 dark:text-amber-300 text-sm">
              <TriangleAlert className="h-4 w-4 mt-0.5 shrink-0" />
              <div>
                An official auction (&quot;{existingOfficialForYear.name}&quot;) already exists for {parsedYear}.
                Having two official drafts for the same year can skew historical estimates.
              </div>
            </div>
          )}

          <div className="flex items-center justify-between">
            <Label>Draft Order</Label>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleRandomize}
              disabled={orderedTeams.length < 2 || isLoading}
              className="max-md:h-10"
            >
              <Shuffle className="h-4 w-4 mr-1" />
              Randomize
            </Button>
          </div>
        </div>

          <div className="md:min-h-0 md:flex-1 md:overflow-y-auto">
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={handleDragEnd}
            >
              <SortableContext items={orderedTeams} strategy={verticalListSortingStrategy}>
                <div className="space-y-2">
                  {orderedTeams.map((team, index) => (
                    <SortableTeamItem key={team.id} team={team} index={index} />
                  ))}
                </div>
              </SortableContext>
            </DndContext>
          </div>
        </div>

        <DialogFooter className="shrink-0 pt-4 max-md:px-4">
          <Button
            variant="outline"
            onClick={onClose}
            disabled={isLoading}
          >
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={!name.trim() || !isYearValid || orderedTeams.length === 0 || isLoading}
            className="min-w-32"
          >
            {isLoading ? 'Creating...' : sameTypeActiveAuction ? 'Proceed' : 'Start Auction'}
          </Button>
        </DialogFooter>

        <Dialog
          open={!!conflictingAuction}
          onOpenChange={(open) => !open && closeConflictConfirmation()}
        >
          <DialogContent variant="alert" className="max-w-md">
            <DialogHeader>
              <DialogTitle>Active {type} draft</DialogTitle>
              <DialogDescription>
                &quot;{conflictingAuction?.name}&quot; is still active. Complete it to save it as read-only history, or permanently delete it before starting this draft.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={closeConflictConfirmation}
                disabled={isLoading}
              >
                Back
              </Button>
              <Button
                onClick={() => void resolveConflictAndCreate('complete')}
                disabled={isLoading}
              >
                {isLoading ? 'Saving...' : 'Complete and save to history'}
              </Button>
              <Button
                variant="destructive"
                onClick={() => void resolveConflictAndCreate('delete')}
                disabled={isLoading}
              >
                {isLoading ? 'Deleting...' : 'Delete active draft'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </DialogContent>
    </Dialog>
  );
}
