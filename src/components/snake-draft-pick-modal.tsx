'use client';

import { useState, useMemo } from 'react';
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
import { FantasyTeam } from '@/server/types/fantasy-team';
import { useAllPlayers } from '@/hooks/use-players';
import { useAllDraftPicks, useCreateDraftPick } from '@/hooks/use-draft-picks';
import { Search, Loader2 } from 'lucide-react';

interface SnakeDraftPickModalProps {
  isOpen: boolean;
  onClose: () => void;
  team: FantasyTeam;
  pickOrder: number;
  onSuccess: () => void;
}

export function SnakeDraftPickModal({
  isOpen,
  onClose,
  team,
  pickOrder,
  onSuccess
}: SnakeDraftPickModalProps) {
  const [searchTerm, setSearchTerm] = useState('');
  const [positionFilter, setPositionFilter] = useState<string>('all');
  const [selectedPlayer, setSelectedPlayer] = useState<Player | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const { data: players = [] } = useAllPlayers();
  const { data: draftPicks = [] } = useAllDraftPicks();
  const createDraftPick = useCreateDraftPick();

  // Filter available players
  const availablePlayers = useMemo(() => {
    // Get drafted player IDs
    const draftedPlayerIds = new Set(draftPicks.map(pick => pick.player_id));

    return players.filter(player => {
      // Remove already drafted players
      if (draftedPlayerIds.has(player.id)) return false;

      // Filter by search term
      if (searchTerm.trim()) {
        const search = searchTerm.toLowerCase();
        if (!player.name.toLowerCase().includes(search) &&
          !player.team.toLowerCase().includes(search)) {
          return false;
        }
      }

      // Filter by position
      if (positionFilter !== 'all' && player.position !== positionFilter) {
        return false;
      }

      return true;
    });
  }, [players, draftPicks, searchTerm, positionFilter]);

  // Sort available players by rank
  const sortedPlayers = useMemo(() => {
    return [...availablePlayers].sort((a, b) => a.rank - b.rank);
  }, [availablePlayers]);

  // Reset state when modal opens/closes
  const handleClose = () => {
    setSearchTerm('');
    setPositionFilter('all');
    setSelectedPlayer(null);
    onClose();
  };

  const handleSubmit = async () => {
    if (!selectedPlayer) return;

    setIsLoading(true);
    try {
      // pick_order is assigned server-side (pb_hooks/draft_picks_pick_order.pb.js);
      // the pickOrder prop remains display-only ("Pick #N").
      await createDraftPick.mutateAsync({
        fantasy_team_id: team.id,
        player_id: selectedPlayer.id,
      });

      onSuccess();
      handleClose();
    } catch (error) {
      console.error('Failed to create snake draft pick:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const positions = ['QB', 'RB', 'WR', 'TE', 'K', 'DST'];

  return (
    <Dialog open={isOpen} onOpenChange={handleClose}>
      <DialogContent className="flex flex-col overflow-hidden md:max-h-[80vh] md:max-w-2xl">
        <DialogHeader className="shrink-0 text-left max-md:pt-4 max-md:pr-12 max-md:pl-4">
          <DialogTitle>Snake Draft Pick</DialogTitle>
          <DialogDescription>
            Select a player for <strong>{team.name}</strong> (Pick #{pickOrder})
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden px-2 py-4 max-md:px-4">
          {/* Filters */}
          <div className="flex gap-4 max-md:flex-col max-md:gap-3">
            <div className="flex-1">
              <Label htmlFor="search">Search Players</Label>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400" />
                <Input
                  id="search"
                  placeholder="Search by name or team..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="pl-10 max-md:h-11"
                />
              </div>
            </div>
            <div className="w-32 max-md:w-full">
              <Label htmlFor="position">Position</Label>
              <Select value={positionFilter} onValueChange={setPositionFilter}>
                <SelectTrigger className="max-md:w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All</SelectItem>
                  {positions.map(pos => (
                    <SelectItem key={pos} value={pos}>{pos}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Player List */}
          {/* Below md the list fills whatever height is left instead of a fixed
              384px block that would push the footer off a phone screen. */}
          <div className="border rounded-lg overflow-hidden max-md:flex max-md:min-h-0 max-md:flex-1 max-md:flex-col">
            <div className="h-96 overflow-y-auto max-md:h-auto max-md:min-h-0 max-md:flex-1">
              {sortedPlayers.length === 0 ? (
                <div className="flex items-center justify-center h-32 text-gray-500">
                  No available players found
                </div>
              ) : (
                <div className="divide-y">
                  {sortedPlayers.slice(0, 50).map((player) => (
                    <div
                      key={player.id}
                      className={`p-3 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors ${selectedPlayer?.id === player.id ? 'bg-blue-50 dark:bg-blue-900/20' : ''
                        }`}
                      onClick={() => setSelectedPlayer(player)}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex min-w-0 items-center gap-3">
                          <PlayerAvatar
                            name={player.name}
                            position={player.position}
                            team={player.team}
                            sleeperId={player.sleeper_id}
                            espnId={player.espn_id}
                            size={24}
                          />
                          <div className="min-w-0">
                            <PlayerNameButton player={player} className="font-semibold" />
                            <div className="truncate text-sm text-gray-500">
                              {player.team} • Ovr. Rank #{player.rank} • Pos. Rank #{player.position_rank} • Tier {player.tier}
                            </div>
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          <PositionBadge position={player.position} />
                        </div>
                      </div>
                    </div>
                  ))}
                  {sortedPlayers.length > 50 && (
                    <div className="p-3 text-center text-gray-500 text-sm">
                      Showing top 50 results. Use search to narrow down.
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Selected Player Summary */}
          {selectedPlayer && (
            <div className="border rounded-lg p-4 bg-blue-50 dark:bg-blue-900/20">
              <div className="flex items-center justify-between">
                <div>
                  <PlayerNameButton player={selectedPlayer} className="text-lg font-semibold" />
                  <div className="text-sm text-gray-600 dark:text-gray-400">
                    {selectedPlayer.team} • Rank #{selectedPlayer.rank} • Tier {selectedPlayer.tier}
                  </div>
                </div>
                <PositionBadge position={selectedPlayer.position} />
              </div>
            </div>
          )}
        </div>

        <DialogFooter className="max-md:px-4">
          <Button
            variant="outline"
            onClick={handleClose}
            disabled={isLoading}
          >
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={!selectedPlayer || isLoading}
            className="min-w-24"
          >
            {isLoading ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
                ...
              </>
            ) : (
              'Draft Player'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
