// AI player selection for the snake phase (rounds 8–15). Best-available by
// overall rank, weighted by roster need and by the team's own profile — how much
// it favours a position in the snake rounds, whether it chases positional runs,
// and which NFL teams and rookies it reaches for — with a hard constraint that
// forces the required starter slots (notably K and DST, which get no auction
// value) to be filled before the roster runs out of picks.

import type { Player } from '@/server/types/player';
import { DEFAULT_ROSTER_SETTINGS, type RosterSettings } from '@/lib/roster';
import { getStarterRequirements } from './pricing';
import { playerAffinity, RUN_WINDOW, runShareAt } from './profiles';
import { MockDraftParams, PARAMS } from './params';
import { seededRandom, weightedPick } from './rng';
import { isAuctionPosition, TeamState } from './types';

const FLEX_POSITIONS = new Set(['RB', 'WR', 'TE']);

// Positions a manager in this league actually PLANS to put in the flex. TE is
// flex-eligible by the rules and almost never flexed in practice: half of all real
// rosters (2018-2025) end with exactly one tight end, so a second TE is depth, not
// a starter slot being filled. Scoring it as an open flex gave it need 0.7 against
// depth's 0.3 and pushed 95% of simulated teams to a second TE.
const FLEX_PLAN_POSITIONS = new Set(['RB', 'WR']);
// How many top-scored players a league-average manager samples its pick from is
// `params.snakeTopN`; these are the bounds a reacher / best-available manager
// moves that to.
const MIN_TOP_N = 2;
const MAX_TOP_N = 8;
// ponytail: the candidate pool scales linearly with the reach index — a manager who
// reaches 60% further than the league considers ~60% more players. A tuning knob,
// not a derived constant; adjust if sims come out too orderly or too chaotic.

// K and DST are replacement-level: this league takes them in the last rounds, not
// whenever the depth pool thins out. Scoring their open starter slot as an ordinary
// need (1.0) beat depth (0.3) as soon as the best available ran past ~rank 100,
// which landed them in rounds 8–11. They still always get filled — the hard
// constraint below forces them once the picks run out (rounds 14–15).
const LATE_FILL_POSITIONS = new Set(['K', 'DST']);
const LATE_FILL_NEED = 0.02;

// How many players beyond the starter slots a manager will roster at a position.
// Nobody carries a sixth quarterback: one backup QB or TE is the realistic ceiling,
// K and DST are never doubled up, and RB/WR depth is left uncapped because that is
// where real benches go. Positions absent here have no cap.
const BENCH_ALLOWANCE: Record<string, number> = { QB: 1, TE: 1, K: 0, DST: 0 };

// Base weight for a pick that fills no starter slot.
const DEPTH_NEED = 0.3;

// What a BACKUP is worth at a position you can only ever start one of. Generic
// RB/WR depth is worth `DEPTH_NEED` and fades as the count climbs past the
// startable slots; a second QB or TE never got that fade, because TE is
// flex-eligible (so `starterCapacity` said 2) and a second QB is still under its
// own capacity of 1. The result: a second tight end held full depth weight while a
// fifth running back was already halved, so the AI took a rank-183 TE ahead of a
// rank-115 RB and 95% of simulated teams ended with two TEs.
//
// Calibrated against the final rosters of the 2018-2025 official drafts: 77% of
// teams carry a second quarterback, 50% a second tight end. The backup QB is worth
// appreciably more than the backup TE, and both are worth less than a flex body.
const BACKUP_NEED: Record<string, number> = { QB: 0.16, TE: 0.13 };

// Slots a position could plausibly start in — its dedicated slots plus, for
// flex-eligible positions, the flex slots. Players beyond this are pure depth.
function starterCapacity(pos: string, settings: RosterSettings): number {
  const requirements = getStarterRequirements(settings);
  const dedicated = requirements.dedicated[pos] ?? 0;
  return dedicated + (FLEX_POSITIONS.has(pos) ? requirements.flex : 0);
}

// The most players a team will roster at a position, or Infinity when uncapped.
//
// Counts DEDICATED starter slots only, never the flex. TE is the position where
// that matters and it was wrong: TE is flex-eligible, so `starterCapacity` gave it
// 1 dedicated + 1 flex = 2, and the +1 bench allowance turned that into a cap of
// THREE tight ends. The league has rostered three TEs once in 96 team-seasons
// (2020), and the split is 49% one TE / 50% two. A manager who wants a tight end
// in the flex is playing a TE he already rostered, not buying a third.
function positionLimit(pos: string, settings: RosterSettings): number {
  const allowance = BENCH_ALLOWANCE[pos];
  if (allowance === undefined) return Infinity;
  return (getStarterRequirements(settings).dedicated[pos] ?? 0) + allowance;
}

function snakeNeed(team: TeamState, player: Player, settings: RosterSettings): number {
  const pos = player.position;
  const requirements = getStarterRequirements(settings);
  if (LATE_FILL_POSITIONS.has(pos) && (requirements.dedicated[pos] ?? 0) > 0) {
    return LATE_FILL_NEED;
  }
  const required = requirements.dedicated[pos] ?? 0;
  const filled = team.filledStarters[pos] ?? 0;
  if (filled < required) return 1.0; // open dedicated starter slot
  if (FLEX_PLAN_POSITIONS.has(pos) && team.filledFlexStarters < requirements.flex) return 0.7; // open FLEX
  // Starter is covered and this position only ever starts one — anything more is a
  // backup, not depth.
  if (BACKUP_NEED[pos] !== undefined && required > 0) return BACKUP_NEED[pos];

  // Depth, with diminishing returns. A flat depth weight made every bench pick
  // equally attractive, so a positional bias — never decremented by the picks it
  // caused — kept winning the same position every remaining round, which is how a
  // team ended up rostering six quarterbacks.
  const depth = Math.max(0, (team.countByPosition[pos] ?? 0) - starterCapacity(pos, settings));
  return DEPTH_NEED / (1 + depth);
}

// Positions that would fill a still-required starter slot for this team.
function requiredFillPositions(team: TeamState, settings: RosterSettings): Set<string> {
  const set = new Set<string>();
  const requirements = getStarterRequirements(settings);
  for (const [pos, required] of Object.entries(requirements.dedicated)) {
    if ((team.filledStarters[pos] ?? 0) < required) set.add(pos);
  }
  if (team.filledFlexStarters < requirements.flex) {
    for (const pos of FLEX_POSITIONS) set.add(pos);
  }
  return set;
}

function rankScore(player: Player): number {
  return player.rank > 0 ? 1 / player.rank : 0.001;
}

// The team's profile-driven pull toward this player: how much it favours the
// position in the snake rounds, how it reacts to a run at that position right now,
// and its NFL-team / rookie leanings. K and DST carry no positional bias — they are
// filled on the roster clock, not by preference.
function profilePull(team: TeamState, player: Player, recentPositions: string[]): number {
  const posBias = isAuctionPosition(player.position)
    ? team.profile.snakePosBias[player.position]
    : 1;
  const runShare = runShareAt(recentPositions, recentPositions.length, player.position);
  const runFactor = 1 + (team.profile.runResponse - 1) * runShare;
  return posBias * runFactor * playerAffinity(team.profile, player);
}

// Choose a snake pick for `team` from the available players. Assumes `available`
// is non-empty. `recentPositions` holds the positions of the picks immediately
// before this one, oldest first, for run detection. Deterministic given
// (auctionId, pickOrder).
export function chooseSnakePick(
  team: TeamState,
  available: Player[],
  auctionId: string,
  pickOrder: number,
  settings: RosterSettings = DEFAULT_ROSTER_SETTINGS,
  recentPositions: string[] = [],
  params: MockDraftParams = PARAMS
): Player {
  const rosterSize = settings.starterPositions.length + settings.benchSize;
  const remainingPicks = rosterSize - team.totalPicks;
  const requirements = getStarterRequirements(settings).dedicated;
  const configuredPool = available.filter(
    (player) =>
      (!LATE_FILL_POSITIONS.has(player.position) || (requirements[player.position] ?? 0) > 0) &&
      // Positional roster cap: no manager drafts a third quarterback, whatever their
      // profile says. Uncapped for RB/WR.
      (team.countByPosition[player.position] ?? 0) < positionLimit(player.position, settings)
  );

  // Do not draft K/DST in leagues that omit those positions unless no configured
  // position remains. Required K/DST stay available and are forced at the deadline.
  let pool = configuredPool.length > 0 ? configuredPool : available;

  // Hard constraint: if there are exactly as many picks left as unfilled required
  // starters, every remaining pick must fill a required slot (guarantees K/DST).
  if (remainingPicks <= team.unfilledRequiredStarters) {
    const allowed = requiredFillPositions(team, settings);
    const restricted = available.filter((p) => allowed.has(p.position));
    if (restricted.length > 0) pool = restricted;
  }

  // A strict best-available manager samples from the top 2; one who habitually
  // reaches considers up to 8, which is what makes their picks look like reaches.
  const topN = Math.min(
    MAX_TOP_N,
    Math.max(MIN_TOP_N, Math.round(params.snakeTopN * team.profile.snakeReachIndex))
  );

  const window = recentPositions.slice(-RUN_WINDOW);
  const scored = pool
    .map((player) => ({
      player,
      score:
        rankScore(player) *
        snakeNeed(team, player, settings) *
        profilePull(team, player, window),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topN);

  // Sample the pick weighted by score, so the best-available is usually taken but
  // not always — a mild, deterministic dose of unpredictability.
  const rng = seededRandom(auctionId, `snake:${pickOrder}:${team.teamId}`);
  const chosen = weightedPick(scored, scored.map((s) => s.score), rng());
  return chosen.player;
}
