'use client';

import { useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  getPositionBackgroundClasses,
  getPositionGradientClasses,
} from '@/lib/position-colors';
import { useAllFantasyTeams } from '@/hooks/use-fantasy-teams';
import { useTeamProfiles } from '@/hooks/use-team-profiles';
import { AUCTION_POSITIONS } from '@/lib/mock-draft/types';
import type { AuctionPosition, TeamProfile } from '@/lib/mock-draft/types';

// Widest snake bias a bar is drawn to. Bias is clamped to 2.5 upstream, but a scale
// that reaches it wastes most of its width — ±60% already reads as a strong lean.
const BIAS_AXIS = 0.6;
// How many NFL teams to surface at each end of the lean.
const TEAM_CHIPS = 3;

function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function signedPct(value: number): string {
  const delta = Math.round((value - 1) * 100);
  return `${delta > 0 ? '+' : ''}${delta}%`;
}

// --- Meter -------------------------------------------------------------------

interface ProfileMeterProps {
  label: string;
  value: string;
  // Position of the fill and of the league tick, both 0-1 along the track.
  fraction: number;
  leagueFraction: number;
  hint: string;
}

// A value on a fixed scale with the league average marked, so a number reads as a
// deviation from the league rather than as an absolute nobody has a feel for.
function ProfileMeter({ label, value, fraction, leagueFraction, hint }: ProfileMeterProps) {
  return (
    <div className="space-y-1" title={hint}>
      <div className="flex items-baseline justify-between text-xs">
        <span className="font-medium text-foreground">{label}</span>
        <span className="tabular-nums text-muted-foreground">{value}</span>
      </div>
      <div className="relative h-2 w-full rounded-full bg-muted">
        <div
          className="h-2 rounded-full bg-foreground/70"
          style={{ width: `${Math.min(100, Math.max(0, fraction * 100))}%` }}
        />
        <div
          className="absolute inset-y-0 w-px bg-foreground/40"
          style={{ left: `${Math.min(100, Math.max(0, leagueFraction * 100))}%` }}
          title="league average"
        />
      </div>
    </div>
  );
}

// --- Card --------------------------------------------------------------------

// League means across the computed profiles, used as the reference tick on every
// meter and as the baseline the archetype line describes deviations from.
interface LeagueMeans {
  aggression: number;
  concentration: number;
}

// A short, plain-English read of what makes this manager different. Only the traits
// that actually deviate get named, so a league-average team says so.
function archetype(profile: TeamProfile, league: LeagueMeans): string {
  const traits: string[] = [];

  if (profile.concentration > league.concentration + 0.08) traits.push('Stars-and-scrubs');
  else if (profile.concentration < league.concentration - 0.08) traits.push('Balanced roster');

  if (profile.aggression > league.aggression + 0.06) traits.push('overpays');
  else if (profile.aggression < league.aggression - 0.06) traits.push('value-hunts');

  const leanPos = AUCTION_POSITIONS.reduce((best, pos) =>
    profile.snakePosBias[pos] > profile.snakePosBias[best] ? pos : best
  );
  if (profile.snakePosBias[leanPos] > 1.15) traits.push(`${leanPos}-early`);

  if (profile.snakeReachIndex > 1.12) traits.push('reaches');
  else if (profile.snakeReachIndex < 0.88) traits.push('best-available');

  if (profile.runResponse > 1.12) traits.push('chases runs');
  else if (profile.runResponse < 0.88) traits.push('zags on runs');

  if (profile.rookieBias > 1.25) traits.push('rookie-hungry');
  else if (profile.rookieBias < 0.75) traits.push('avoids rookies');

  return traits.length > 0 ? traits.join(' · ') : 'League-average drafter';
}

interface TeamProfileCardProps {
  teamName: string;
  profile: TeamProfile;
  league: LeagueMeans;
}

function TeamProfileCard({ teamName, profile, league }: TeamProfileCardProps) {
  const teamLean = useMemo(() => {
    const entries = Object.entries(profile.nflTeamBias).sort((a, b) => b[1] - a[1]);
    return {
      favors: entries.filter(([, bias]) => bias > 1).slice(0, TEAM_CHIPS),
      avoids: entries.filter(([, bias]) => bias < 1).slice(-TEAM_CHIPS).reverse(),
    };
  }, [profile.nflTeamBias]);

  return (
    <Card>
      <CardHeader className="gap-1">
        <CardTitle className="text-base">{teamName}</CardTitle>
        <p className="text-xs text-muted-foreground">{archetype(profile, league)}</p>
        <Badge variant="secondary" className="w-fit font-normal">
          {profile.sampleSize + profile.snakeSampleSize > 0
            ? `${profile.sampleSize} auction · ${profile.snakeSampleSize} snake picks`
            : 'no history — league average'}
        </Badge>
      </CardHeader>

      <CardContent className="space-y-5">
        <div className="space-y-1.5">
          <div className="text-xs font-medium text-muted-foreground">Auction spend</div>
          {/* 2px surface gaps separate the segments; no strokes. */}
          <div className="flex h-3 w-full gap-0.5 overflow-hidden rounded-full">
            {AUCTION_POSITIONS.map((pos) => (
              <div
                key={pos}
                className={`${getPositionBackgroundClasses(pos)} first:rounded-l-full last:rounded-r-full`}
                style={{ width: `${Math.max(profile.posBudgetShare[pos] * 100, 0)}%` }}
                title={`${pos} ${pct(profile.posBudgetShare[pos])} of budget`}
              />
            ))}
          </div>
          <div className="grid grid-cols-4 gap-2 text-xs text-muted-foreground">
            {AUCTION_POSITIONS.map((pos) => (
              <div key={pos} className="flex items-center gap-1">
                <span className={`h-2 w-2 rounded-full ${getPositionBackgroundClasses(pos)}`} />
                {pos} {pct(profile.posBudgetShare[pos])}
              </div>
            ))}
          </div>
        </div>

        <div className="space-y-1.5">
          <div className="text-xs font-medium text-muted-foreground">
            Snake-round lean <span className="font-normal">(vs league)</span>
          </div>
          <div className="space-y-1">
            {AUCTION_POSITIONS.map((pos) => (
              <DivergingBiasBar key={pos} position={pos} bias={profile.snakePosBias[pos]} />
            ))}
          </div>
        </div>

        <div className="space-y-3">
          <ProfileMeter
            label="Aggression"
            value={`${profile.aggression.toFixed(2)}×`}
            fraction={(profile.aggression - 0.7) / 0.7}
            leagueFraction={(league.aggression - 0.7) / 0.7}
            hint="Price paid relative to the league value estimate."
          />
          <ProfileMeter
            label="Concentration"
            value={pct(profile.concentration)}
            fraction={profile.concentration}
            leagueFraction={league.concentration}
            hint="Share of auction spend in the two priciest buys."
          />
          <ProfileMeter
            label="Reach"
            value={`${signedPct(profile.snakeReachIndex)} · ${Math.round(profile.snakeReach)} ranks`}
            fraction={(profile.snakeReachIndex - 0.6) / 1}
            leagueFraction={(1 - 0.6) / 1}
            hint="How far past the best player still on the board this manager drafts, relative to the league."
          />
          <ProfileMeter
            label="Run response"
            value={signedPct(profile.runResponse)}
            fraction={(profile.runResponse - 0.5) / 1.3}
            leagueFraction={(1 - 0.5) / 1.3}
            hint="Above 0% chases a positional run; below zags against it."
          />
          <ProfileMeter
            label="Rookie appetite"
            value={signedPct(profile.rookieBias)}
            fraction={(profile.rookieBias - 0.3) / 2.2}
            leagueFraction={(1 - 0.3) / 2.2}
            hint="Rookies drafted relative to the league rate."
          />
        </div>

        <div className="space-y-1.5">
          <div className="text-xs font-medium text-muted-foreground">NFL team lean</div>
          {teamLean.favors.length === 0 && teamLean.avoids.length === 0 ? (
            <p className="text-xs text-muted-foreground">No consistent lean.</p>
          ) : (
            <div className="flex flex-wrap gap-1">
              {teamLean.favors.map(([team, bias]) => (
                <Badge key={team} variant="outline" className="font-normal tabular-nums">
                  {team} {signedPct(bias)}
                </Badge>
              ))}
              {teamLean.avoids.map(([team, bias]) => (
                <Badge
                  key={team}
                  variant="outline"
                  className="font-normal tabular-nums text-muted-foreground"
                >
                  {team} {signedPct(bias)}
                </Badge>
              ))}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// One position's snake lean, drawn left or right of a shared center line so the
// direction reads before the number does.
function DivergingBiasBar({ position, bias }: { position: AuctionPosition; bias: number }) {
  const delta = Math.max(-BIAS_AXIS, Math.min(BIAS_AXIS, bias - 1));
  const width = (Math.abs(delta) / BIAS_AXIS) * 50;

  return (
    <div className="flex items-center gap-2 text-xs" title={`${position} ${signedPct(bias)} vs league`}>
      <span className="w-6 shrink-0 font-medium text-muted-foreground">{position}</span>
      <div className="relative h-2.5 flex-1">
        <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border" />
        <div
          className={`absolute inset-y-0 rounded-sm bg-gradient-to-r ${getPositionGradientClasses(position)}`}
          style={
            delta >= 0
              ? { left: '50%', width: `${width}%` }
              : { right: '50%', width: `${width}%` }
          }
        />
      </div>
      <span className="w-10 shrink-0 text-right tabular-nums text-muted-foreground">
        {signedPct(bias)}
      </span>
    </div>
  );
}

// --- View --------------------------------------------------------------------

export function TeamProfilesView() {
  const { data: teams = [], isLoading: teamsLoading } = useAllFantasyTeams();
  const { data: profiles = new Map(), isLoading: profilesLoading } = useTeamProfiles();

  const sortedTeams = useMemo(
    () => [...teams].sort((a, b) => a.draft_order - b.draft_order),
    [teams]
  );

  // Reference line for every meter: the mean across the profiles actually shown.
  const league = useMemo<LeagueMeans>(() => {
    const all = [...profiles.values()];
    if (all.length === 0) return { aggression: 1, concentration: 0.4 };
    const mean = (pick: (p: TeamProfile) => number) =>
      all.reduce((sum, p) => sum + pick(p), 0) / all.length;
    return {
      aggression: mean((p) => p.aggression),
      concentration: mean((p) => p.concentration),
    };
  }, [profiles]);

  const isLoading = teamsLoading || profilesLoading;

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">
        How each manager has actually drafted since 2018, across both the auction and the
        snake rounds. These tendencies drive how the AI plays each opponent in simulated
        mock drafts.
      </p>

      {isLoading ? (
        <div className="text-center py-12 text-muted-foreground">Loading profiles&hellip;</div>
      ) : sortedTeams.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">No fantasy teams yet.</div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {sortedTeams.map((team) => {
            const profile = profiles.get(team.id);
            if (!profile) return null;
            return (
              <TeamProfileCard
                key={team.id}
                teamName={team.name}
                profile={profile}
                league={league}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
