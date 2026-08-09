'use client';

import { useState, useEffect } from 'react';
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { PositionBadge } from '@/components/position-badge';
import { PlayerAvatar } from '@/components/player-avatar';
import { PlayerNameButton } from '@/components/player-name-button';
import { Player } from '@/server/types/player';
import { useAuctionTeams } from '@/hooks/use-fantasy-teams';
import { useAllDraftPicks, useCreateDraftPick } from '@/hooks/use-draft-picks';
import { useDraftRole, useLeague } from '@/hooks/use-league';
import { DollarSign } from 'lucide-react';
import { calculateBudgetSummary } from '@/lib/roster';

interface DraftConfirmationModalProps {
  isOpen: boolean;
  onClose: () => void;
  player: Player;
  initialValue: string;
  onSuccess: () => void;
}

export function DraftConfirmationModal({
  isOpen,
  onClose,
  player,
  initialValue,
  onSuccess
}: DraftConfirmationModalProps) {
  const [selectedTeamId, setSelectedTeamId] = useState('');
  const [finalValue, setFinalValue] = useState(initialValue);
  const [isLoading, setIsLoading] = useState(false);

  const { data: teams = [] } = useAuctionTeams();
  const { data: draftPicks = [] } = useAllDraftPicks();
  const createDraftPick = useCreateDraftPick();
  // Admin lane picks for any team; a member can only record a win for their
  // own team (the PB rule rejects anything else anyway).
  const { canPickAnyTeam, userTeamId } = useDraftRole();
  const { settings } = useLeague();

  // Reset state when modal opens; members are locked to their own team.
  useEffect(() => {
    if (isOpen) {
      setSelectedTeamId(canPickAnyTeam ? '' : userTeamId ?? '');
      setFinalValue(initialValue);
    }
  }, [isOpen, initialValue, canPickAnyTeam, userTeamId]);

  const handleCancel = () => {
    setSelectedTeamId('');
    setFinalValue(initialValue);
    onClose();
  };

  const handleSubmit = async () => {
    if (!selectedTeamId || !finalValue.trim()) return;

    setIsLoading(true);
    try {
      if (!teams.some(team => team.id === selectedTeamId)) {
        throw new Error('Team not found');
      }

      // Create the draft pick with the winning bid as its price.
      // pick_order is assigned server-side (pb_hooks/draft_picks_pick_order.pb.js).
      await createDraftPick.mutateAsync({
        fantasy_team_id: selectedTeamId,
        player_id: player.id,
        price: parseFloat(finalValue),
      });

      onSuccess();
      onClose();
    } catch (error) {
      console.error('Failed to create draft pick:', error);
    } finally {
      setIsLoading(false);
    }
  };

  // Sort teams by draft order and filter out teams with all paid slots filled;
  // members only ever see their own team in the list.
  const sortedTeams = [...teams]
    .sort((a, b) => a.draft_order - b.draft_order)
    .filter((team) => {
      if (!canPickAnyTeam && team.id !== userTeamId) return false;
      const teamAuctionPicks = draftPicks.filter(pick =>
        pick.fantasy_team_id === team.id &&
        pick.price &&
        pick.price > 0
      ).length;
      return teamAuctionPicks < settings.paidAuctionSlots;
    });

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="flex flex-col overflow-hidden md:max-w-md">
        <DialogHeader className="shrink-0 text-left max-md:pt-4 max-md:pr-12 max-md:pl-4">
          <DialogTitle>Confirm Draft Pick</DialogTitle>
          <DialogDescription>
            Select the team that drafted this player and confirm the auction value.
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-6 overflow-y-auto py-4 max-md:space-y-4 max-md:px-4">
          {/* Player Info */}
          <div className="flex items-center gap-3 rounded-lg bg-gray-50 p-4 dark:bg-gray-800 max-md:p-3">
            <PlayerAvatar
              name={player.name}
              position={player.position}
              team={player.team}
              sleeperId={player.sleeper_id}
              espnId={player.espn_id}
              size={48}
            />
            <div className="min-w-0 flex-1">
              <PlayerNameButton
                player={player}
                className="font-semibold text-gray-900 dark:text-white"
              />
              <div className="truncate text-sm text-gray-500 dark:text-gray-400">
                {player.team} • Rank #{player.rank}
              </div>
            </div>
            <PositionBadge position={player.position} />
          </div>

          {/* Team Selection */}
          <div className="space-y-2">
            <Label htmlFor="team-select">Drafting Team</Label>
            <Select value={selectedTeamId} onValueChange={setSelectedTeamId} disabled={!canPickAnyTeam}>
              <SelectTrigger className="max-md:w-full max-md:min-w-0">
                <SelectValue placeholder="Select team..." />
              </SelectTrigger>
              <SelectContent>
                {sortedTeams.map((team) => {
                  const teamPickCount = draftPicks.filter(pick => pick.fantasy_team_id === team.id).length;
                  const teamDraftPicks = draftPicks.filter(pick => pick.fantasy_team_id === team.id);
                  const { remainingBudget } = calculateBudgetSummary(teamDraftPicks);

                  return (
                    <SelectItem key={team.id} value={team.id}>
                      <div className="flex items-center justify-between w-full min-w-0">
                        <span className="truncate">{team.name}</span>
                        <span className="truncate text-xs text-gray-500 ml-2">
                          Pick #{team.draft_order} • {teamPickCount} players • ${remainingBudget} left
                        </span>
                      </div>
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
          </div>

          {/* Auction Value */}
          <div className="space-y-2">
            <Label htmlFor="auction-value">Final Auction Value</Label>
            <div className="flex items-center gap-2">
              <DollarSign className="h-4 w-4 text-gray-500" />
              <Input
                id="auction-value"
                type="number"
                inputMode="numeric"
                placeholder="0"
                value={finalValue}
                onChange={(e) => setFinalValue(e.target.value)}
                min="0"
                step="1"
                className="flex-1 max-md:h-11"
              />
            </div>
          </div>
        </div>

        <DialogFooter className="shrink-0 max-md:px-4">
          <Button
            variant="outline"
            onClick={handleCancel}
            disabled={isLoading}
          >
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={!selectedTeamId || !finalValue.trim() || isLoading}
            className="min-w-24"
          >
            {isLoading ? 'Saving...' : 'Draft Player'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
