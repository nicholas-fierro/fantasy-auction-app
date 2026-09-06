'use client';

import { useState, type FormEvent } from 'react';
import { ClientResponseError } from 'pocketbase';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useCreateLeague } from '@/hooks/use-create-league';
import { useNavigation } from '@/contexts/navigation-context';
import {
  DEFAULT_ROSTER_SETTINGS,
  isDraftFormat,
  validateRosterSettings,
  type DraftFormat,
  type RosterSettings,
} from '@/lib/roster';
import { isScoringFormat, type ScoringFormat } from '@/lib/fantasy-scoring';

export function CreateLeagueDialog() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>Create a league</Button>
      <Dialog open={open} onOpenChange={setOpen}>
        {open && <CreateLeagueForm onClose={() => setOpen(false)} />}
      </Dialog>
    </>
  );
}

function CreateLeagueForm({ onClose }: { onClose: () => void }) {
  const createLeague = useCreateLeague();
  const { selectLeague } = useNavigation();
  const defaults = DEFAULT_ROSTER_SETTINGS;
  const [name, setName] = useState('');
  const [teamCount, setTeamCount] = useState('12');
  const [teamNames, setTeamNames] = useState<string[]>(
    Array.from({ length: 12 }, () => '')
  );
  const [commissionerTeamIndex, setCommissionerTeamIndex] = useState('0');
  const [draftFormat, setDraftFormat] = useState<DraftFormat>(
    defaults.draftFormat
  );
  const [scoringFormat, setScoringFormat] = useState<ScoringFormat>(
    defaults.scoringFormat
  );
  const [starterPositions, setStarterPositions] = useState(
    defaults.starterPositions.join(', ')
  );
  const [benchSize, setBenchSize] = useState(String(defaults.benchSize));
  const [budget, setBudget] = useState(String(defaults.budget));
  const [paidSlots, setPaidSlots] = useState(String(defaults.paidAuctionSlots));
  const [minimumBid, setMinimumBid] = useState(String(defaults.minimumBid));
  const [error, setError] = useState<string | null>(null);
  const snake = draftFormat === 'snake';

  function changeTeamCount(value: string) {
    setTeamCount(value);
    const count = Number(value);
    if (!Number.isInteger(count) || count < 2 || count > 32) return;
    setTeamNames((previous) =>
      Array.from({ length: count }, (_, index) => previous[index] ?? '')
    );
    if (Number(commissionerTeamIndex) >= count) setCommissionerTeamIndex('0');
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (createLeague.isPending) return;
    setError(null);
    const count = Number(teamCount);
    if (
      !Number.isInteger(count) ||
      count < 2 ||
      count > 32 ||
      count !== teamNames.length
    ) {
      setError('Choose between 2 and 32 teams.');
      return;
    }
    const names = teamNames.map((team) => team.trim());
    if (
      !name.trim() ||
      name.trim().length > 100 ||
      names.some((team) => !team || team.length > 100)
    ) {
      setError('League and team names must contain 1–100 characters.');
      return;
    }
    if (
      new Set(names.map((team) => team.toLowerCase())).size !== names.length
    ) {
      setError('Team names must be unique within the league.');
      return;
    }
    const settings: RosterSettings = {
      draftFormat,
      scoringFormat,
      starterPositions: starterPositions
        .split(',')
        .map((p) => p.trim().toUpperCase())
        .filter(Boolean),
      benchSize: Number(benchSize),
      budget: snake ? 0 : Number(budget),
      paidAuctionSlots: snake ? 0 : Number(paidSlots),
      minimumBid: snake ? 0 : Number(minimumBid),
    };
    const validationError = validateRosterSettings(settings);
    if (validationError) {
      setError(validationError);
      return;
    }
    if (
      settings.starterPositions.some(
        (p) => !['QB', 'RB', 'WR', 'TE', 'FLEX', 'K', 'DST'].includes(p)
      )
    ) {
      setError('Use QB, RB, WR, TE, FLEX, K, or DST for starter positions.');
      return;
    }
    try {
      const result = await createLeague.mutateAsync({
        name: name.trim(),
        teamNames: names,
        commissionerTeamIndex: Number(commissionerTeamIndex),
        settings,
      });
      selectLeague(result.league.id);
      toast.success('League created');
      onClose();
    } catch (cause) {
      setError(
        cause instanceof ClientResponseError &&
          typeof cause.response.message === 'string'
          ? cause.response.message
          : 'Could not create the league. Please try again.'
      );
    }
  }

  return (
    <DialogContent
      className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl"
      onEscapeKeyDown={(event) => {
        if (createLeague.isPending) event.preventDefault();
      }}
      onInteractOutside={(event) => {
        if (createLeague.isPending) event.preventDefault();
      }}
    >
      <DialogHeader>
        <DialogTitle>Create a league</DialogTitle>
        <DialogDescription>
          You will be the commissioner. Set up teams and draft settings now,
          then invite your league members.
        </DialogDescription>
      </DialogHeader>
      <form onSubmit={submit} className="space-y-5">
        <fieldset disabled={createLeague.isPending} className="space-y-5">
          <div className="space-y-1">
            <Label htmlFor="create-league-name">League name</Label>
            <Input
              id="create-league-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={100}
              required
              autoFocus
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="create-league-count">Number of teams</Label>
            <Input
              id="create-league-count"
              type="number"
              min={2}
              max={32}
              step={1}
              value={teamCount}
              onChange={(e) => changeTeamCount(e.target.value)}
              required
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {teamNames.map((team, index) => (
              <div key={index} className="space-y-1">
                <Label htmlFor={`create-team-${index}`}>
                  Team {index + 1} name
                </Label>
                <Input
                  id={`create-team-${index}`}
                  value={team}
                  maxLength={100}
                  required
                  onChange={(e) =>
                    setTeamNames((previous) =>
                      previous.map((value, i) =>
                        i === index ? e.target.value : value
                      )
                    )
                  }
                />
              </div>
            ))}
          </div>
          <div className="space-y-1">
            <Label htmlFor="create-league-my-team">Your team</Label>
            <Select
              value={commissionerTeamIndex}
              onValueChange={setCommissionerTeamIndex}
              disabled={createLeague.isPending}
            >
              <SelectTrigger id="create-league-my-team">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {teamNames.map((team, index) => (
                  <SelectItem key={index} value={String(index)}>
                    {team.trim() || `Team ${index + 1}`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="create-league-format">Draft format</Label>
              <Select
                value={draftFormat}
                onValueChange={(value) => {
                  if (isDraftFormat(value)) setDraftFormat(value);
                }}
                disabled={createLeague.isPending}
              >
                <SelectTrigger id="create-league-format">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auction">Auction</SelectItem>
                  <SelectItem value="hybrid">
                    Hybrid (auction then snake)
                  </SelectItem>
                  <SelectItem value="snake">Snake</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="create-league-scoring">Scoring format</Label>
              <Select
                value={scoringFormat}
                onValueChange={(value) => {
                  if (isScoringFormat(value)) setScoringFormat(value);
                }}
                disabled={createLeague.isPending}
              >
                <SelectTrigger id="create-league-scoring">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="std">Standard (no PPR)</SelectItem>
                  <SelectItem value="half">Half PPR</SelectItem>
                  <SelectItem value="ppr">Full PPR</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="create-league-starters">Starter positions</Label>
            <Input
              id="create-league-starters"
              value={starterPositions}
              onChange={(e) => setStarterPositions(e.target.value)}
              required
            />
            <p className="text-xs text-muted-foreground">
              Comma-separated, in lineup order. Use QB, RB, WR, TE, FLEX
              (RB/WR/TE), K, DST. Maximum 50 starters.
            </p>
          </div>
          <div className="space-y-1">
            <Label htmlFor="create-league-bench">Bench size</Label>
            <Input
              id="create-league-bench"
              type="number"
              min={0}
              max={50}
              step={1}
              value={benchSize}
              onChange={(e) => setBenchSize(e.target.value)}
              required
            />
          </div>
          {snake ? (
            <p className="text-sm text-muted-foreground">
              Snake drafts use the full roster and have no paid slots or auction
              budget.
            </p>
          ) : (
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-1">
                <Label htmlFor="create-league-budget">Budget</Label>
                <Input
                  id="create-league-budget"
                  type="number"
                  min={1}
                  max={1000000}
                  step="any"
                  value={budget}
                  onChange={(e) => setBudget(e.target.value)}
                  required
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="create-league-paid">Paid slots</Label>
                <Input
                  id="create-league-paid"
                  type="number"
                  min={1}
                  step={1}
                  value={paidSlots}
                  onChange={(e) => setPaidSlots(e.target.value)}
                  required
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="create-league-minbid">Minimum bid</Label>
                <Input
                  id="create-league-minbid"
                  type="number"
                  min={1}
                  max={1000000}
                  step="any"
                  value={minimumBid}
                  onChange={(e) => setMinimumBid(e.target.value)}
                  required
                />
              </div>
            </div>
          )}
        </fieldset>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={onClose}
            disabled={createLeague.isPending}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={createLeague.isPending}>
            {createLeague.isPending ? 'Creating league…' : 'Create league'}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}
