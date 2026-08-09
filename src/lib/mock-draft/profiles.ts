// Per-team drafting-tendency profiles, computed from picks in past official
// auctions and shrunk toward the league average so teams with thin history behave
// like a league-average drafter rather than on noise. Pure and unit-testable.
//
// Three families of stats come out of one pick list:
//   - auction  (priced picks)      posBudgetShare, aggression, concentration
//   - snake    ($0 picks)          snakePosBias, snakeReach, runResponse
//   - affinity (every pick)        nflTeamBias, rookieBias

import { MockDraftParams, PARAMS } from './params';
import {
  AUCTION_POSITIONS,
  AuctionPosition,
  isAuctionPosition,
  TeamProfile,
} from './types';

// One historical pick, joined to the season row for that player in that year.
// `estimate` is the league value estimate the price is judged against and must be
// > 0 to inform the aggression ratio. `price === 0` marks a snake-round pick.
// `rank` / `nflTeam` are 0 / '' for years where that data was never imported (2018),
// and `rookieDataKnown` is false where the rookie flag can't be trusted.
export interface ProfilePick {
  teamId: string;
  year: number;
  position: string;
  price: number;
  estimate: number;
  pickOrder: number;
  rank: number;
  nflTeam: string;
  isRookie: boolean;
  rookieDataKnown: boolean;
}

// How strongly to shrink a team's observed stats toward the league average.
// blended = (n / (n + K)) * observed + (K / (n + K)) * leagueAvg.
// K = 8 means a team needs ~8 picks before its own tendencies dominate.
const SHRINK_K = 8;

// How many picks back to look when deciding whether a positional run is underway.
export const RUN_WINDOW = 6;

// Bounds on the derived multipliers. Wide enough for a real tendency to show,
// tight enough that a thin sample can't produce an absurd sim.
const POS_BIAS_RANGE: [number, number] = [0.4, 2.5];
const NFL_TEAM_BIAS_RANGE: [number, number] = [0.5, 2];
const ROOKIE_BIAS_RANGE: [number, number] = [0.3, 2.5];
const RUN_RESPONSE_RANGE: [number, number] = [0.5, 1.8];
const REACH_INDEX_RANGE: [number, number] = [0.6, 1.6];

// An NFL-team lean under this much deviation is noise; those entries are dropped so
// `nflTeamBias` stays a short list of what the manager actually reaches for.
const NFL_TEAM_BIAS_EPSILON = 0.05;

// Franchises that moved or changed abbreviation inside the 2019-2025 window, plus
// the two spellings FantasyPros has used for Washington.
const NFL_TEAM_ALIASES: Record<string, string> = {
  OAK: 'LV',
  SD: 'LAC',
  STL: 'LA',
  LAR: 'LA',
  WSH: 'WAS',
  JAC: 'JAX',
};

export function normalizeNflTeam(team: string): string {
  const upper = team.trim().toUpperCase();
  return NFL_TEAM_ALIASES[upper] ?? upper;
}

// League-average fallback used when there is no historical data at all (first-ever
// mock, before any official auction is recorded).
export const NEUTRAL_PROFILE: Omit<
  TeamProfile,
  'teamId' | 'sampleSize' | 'snakeSampleSize' | 'affinitySampleSize'
> = {
  posBudgetShare: { QB: 0.12, RB: 0.42, WR: 0.38, TE: 0.08 },
  aggression: 1,
  concentration: 0.4,
  snakePosBias: { QB: 1, RB: 1, WR: 1, TE: 1 },
  snakeReach: 8,
  snakeReachIndex: 1,
  runResponse: 1,
  nflTeamBias: {},
  rookieBias: 1,
};

function clamp(value: number, [min, max]: [number, number]): number {
  return Math.min(max, Math.max(min, value));
}

function shrink(observed: number, leagueAvg: number, n: number, k: number = SHRINK_K): number {
  const w = n / (n + k);
  return w * observed + (1 - w) * leagueAvg;
}

// --- Auction stats -----------------------------------------------------------

interface RawStats {
  posShare: Record<AuctionPosition, number>;
  aggression: number;
  concentration: number;
  n: number;
}

// Raw (pre-shrinkage) tendencies from a set of priced picks, or null if none are
// usable. Every positive-price QB/RB/WR/TE pick informs positional spend,
// concentration, and sample size. Only aggression needs a usable market estimate.
function computeRawStats(picks: ProfilePick[]): RawStats | null {
  const usable = picks.filter(
    (p) => p.price > 0 && isAuctionPosition(p.position)
  );
  if (usable.length === 0) return null;

  const posSpend: Record<AuctionPosition, number> = { QB: 0, RB: 0, WR: 0, TE: 0 };
  let totalSpend = 0;
  let aggNumerator = 0; // sum of price * (price / estimate)
  let aggDenominator = 0; // sum of price  (price-weighting)

  for (const p of usable) {
    const pos = p.position as AuctionPosition;
    posSpend[pos] += p.price;
    totalSpend += p.price;
    if (p.estimate >= 1) {
      aggNumerator += p.price * (p.price / p.estimate);
      aggDenominator += p.price;
    }
  }

  const posShare = { QB: 0, RB: 0, WR: 0, TE: 0 } as Record<AuctionPosition, number>;
  for (const pos of AUCTION_POSITIONS) {
    posShare[pos] = totalSpend > 0 ? posSpend[pos] / totalSpend : 0;
  }

  const aggression = aggDenominator > 0 ? aggNumerator / aggDenominator : 1;

  const sortedPrices = usable.map((p) => p.price).sort((a, b) => b - a);
  const top2 = sortedPrices.slice(0, 2).reduce((sum, v) => sum + v, 0);
  const concentration = totalSpend > 0 ? top2 / totalSpend : 0;

  return { posShare, aggression, concentration, n: usable.length };
}

// --- Snake stats -------------------------------------------------------------

// A snake pick with everything the snake stats need already resolved against the
// rest of its draft: how far past the best available player it went, and how hot
// its position was at that moment.
interface SnakeObservation {
  teamId: string;
  position: AuctionPosition;
  weight: number;
  // null when the year has no rank data (2018) — reach is skipped for those.
  reach: number | null;
  runShare: number;
}

// The best (lowest) rank still on the board at each pick_order of one draft: the
// suffix-min of rank over the picks at or after it. Players who went undrafted are
// ignored — nobody wanted them, so they were not really "available".
function bestAvailableByPickOrder(picks: ProfilePick[]): Map<number, number> {
  const ranked = picks.filter((p) => p.rank > 0).sort((a, b) => b.pickOrder - a.pickOrder);
  const best = new Map<number, number>();
  let min = Infinity;
  for (const pick of ranked) {
    min = Math.min(min, pick.rank);
    best.set(pick.pickOrder, min);
  }
  return best;
}

// Fraction of the `RUN_WINDOW` picks before `index` that were at `position`.
export function runShareAt(
  orderedPositions: string[],
  index: number,
  position: string
): number {
  const start = Math.max(0, index - RUN_WINDOW);
  const window = orderedPositions.slice(start, index);
  if (window.length === 0) return 0;
  return window.filter((p) => p === position).length / window.length;
}

// Resolve every snake pick against its own draft. Weighting decays as
// 1 / (1 + k) over the team's snake picks that year: the early snake rounds reveal
// preference, the late ones are mandatory roster filling that every team does the
// same way.
function buildSnakeObservations(allPicks: ProfilePick[]): SnakeObservation[] {
  const byYear = new Map<number, ProfilePick[]>();
  for (const pick of allPicks) {
    const list = byYear.get(pick.year) ?? [];
    list.push(pick);
    byYear.set(pick.year, list);
  }

  const observations: SnakeObservation[] = [];

  for (const yearPicks of byYear.values()) {
    const ordered = [...yearPicks].sort((a, b) => a.pickOrder - b.pickOrder);
    const positions = ordered.map((p) => p.position);
    const best = bestAvailableByPickOrder(ordered);
    const seenPerTeam = new Map<string, number>();

    ordered.forEach((pick, index) => {
      if (pick.price !== 0 || !isAuctionPosition(pick.position)) return;
      const k = seenPerTeam.get(pick.teamId) ?? 0;
      seenPerTeam.set(pick.teamId, k + 1);

      const bestRank = best.get(pick.pickOrder);
      observations.push({
        teamId: pick.teamId,
        position: pick.position,
        weight: 1 / (1 + k),
        reach: pick.rank > 0 && bestRank !== undefined ? pick.rank - bestRank : null,
        runShare: runShareAt(positions, index, pick.position),
      });
    });
  }

  return observations;
}

interface SnakeStats {
  posShare: Record<AuctionPosition, number>;
  reach: number;
  runShare: number;
  // Effective (weight-summed) sample, used for shrinkage.
  n: number;
  reachN: number;
  // Raw pick count, used for display.
  count: number;
}

function summarizeSnake(observations: SnakeObservation[]): SnakeStats | null {
  if (observations.length === 0) return null;

  const posWeight = { QB: 0, RB: 0, WR: 0, TE: 0 } as Record<AuctionPosition, number>;
  let totalWeight = 0;
  let reachWeight = 0;
  let reachSum = 0;
  let runSum = 0;

  for (const observation of observations) {
    posWeight[observation.position] += observation.weight;
    totalWeight += observation.weight;
    runSum += observation.weight * observation.runShare;
    if (observation.reach !== null) {
      reachWeight += observation.weight;
      reachSum += observation.weight * observation.reach;
    }
  }

  const posShare = { QB: 0, RB: 0, WR: 0, TE: 0 } as Record<AuctionPosition, number>;
  for (const pos of AUCTION_POSITIONS) {
    posShare[pos] = totalWeight > 0 ? posWeight[pos] / totalWeight : 0;
  }

  return {
    posShare,
    reach: reachWeight > 0 ? reachSum / reachWeight : NEUTRAL_PROFILE.snakeReach,
    runShare: totalWeight > 0 ? runSum / totalWeight : 0,
    n: totalWeight,
    reachN: reachWeight,
    count: observations.length,
  };
}

// --- Affinity stats ----------------------------------------------------------

interface AffinityStats {
  nflTeamShare: Map<string, number>;
  // Per-franchise pick counts. The evidence behind "this manager loves the Lions"
  // is how many Lions they took, not how many players they drafted overall — using
  // the latter as the shrinkage n pins every franchise at the clamp bounds.
  nflTeamCount: Map<string, number>;
  rookieShare: number;
  n: number;
  rookieN: number;
}

// NFL-team and rookie leanings, over every pick of both phases. Years that never
// got the underlying data imported simply contribute nothing to that stat.
function summarizeAffinity(picks: ProfilePick[]): AffinityStats | null {
  if (picks.length === 0) return null;

  const nflTeamCount = new Map<string, number>();
  let teamTotal = 0;
  let rookieTotal = 0;
  let rookieCount = 0;

  for (const pick of picks) {
    if (pick.nflTeam) {
      const team = normalizeNflTeam(pick.nflTeam);
      nflTeamCount.set(team, (nflTeamCount.get(team) ?? 0) + 1);
      teamTotal++;
    }
    if (pick.rookieDataKnown) {
      rookieTotal++;
      if (pick.isRookie) rookieCount++;
    }
  }

  const nflTeamShare = new Map<string, number>();
  for (const [team, count] of nflTeamCount) {
    nflTeamShare.set(team, count / teamTotal);
  }

  return {
    nflTeamShare,
    nflTeamCount,
    rookieShare: rookieTotal > 0 ? rookieCount / rookieTotal : 0,
    n: teamTotal,
    rookieN: rookieTotal,
  };
}

// --- Assembly ----------------------------------------------------------------

// Compute a profile per team. `picksByTeam` need only include teams that have
// history; every team id in `teamIds` gets a profile (falling back to the league
// average when it has no usable picks).
export function computeTeamProfiles(
  teamIds: string[],
  picksByTeam: Map<string, ProfilePick[]>,
  params: MockDraftParams = PARAMS
): Map<string, TeamProfile> {
  const k = params.shrinkK;

  // League baselines = every pick pooled across all teams.
  const allPicks = [...picksByTeam.values()].flat();
  const leagueStats = computeRawStats(allPicks);
  const league = leagueStats
    ? {
        posShare: leagueStats.posShare,
        aggression: leagueStats.aggression,
        concentration: leagueStats.concentration,
      }
    : {
        posShare: NEUTRAL_PROFILE.posBudgetShare,
        aggression: NEUTRAL_PROFILE.aggression,
        concentration: NEUTRAL_PROFILE.concentration,
      };

  // Snake and affinity observations are resolved against the whole draft, so they
  // are computed once over the pooled picks and then split per team.
  const allObservations = buildSnakeObservations(allPicks);
  const observationsByTeam = new Map<string, SnakeObservation[]>();
  for (const observation of allObservations) {
    const list = observationsByTeam.get(observation.teamId) ?? [];
    list.push(observation);
    observationsByTeam.set(observation.teamId, list);
  }
  const leagueSnake = summarizeSnake(allObservations);
  const leagueAffinity = summarizeAffinity(allPicks);

  const result = new Map<string, TeamProfile>();

  for (const teamId of teamIds) {
    const teamPicks = picksByTeam.get(teamId) ?? [];
    const raw = computeRawStats(teamPicks);
    const n = raw?.n ?? 0;

    // Shrink each auction stat toward the league average.
    const blendedShare = { QB: 0, RB: 0, WR: 0, TE: 0 } as Record<AuctionPosition, number>;
    for (const pos of AUCTION_POSITIONS) {
      blendedShare[pos] = shrink(raw?.posShare[pos] ?? 0, league.posShare[pos], n, k);
    }
    // Renormalize shares to sum to 1 (shrinkage can perturb the sum slightly).
    const shareSum = AUCTION_POSITIONS.reduce((sum, pos) => sum + blendedShare[pos], 0);
    if (shareSum > 0) {
      for (const pos of AUCTION_POSITIONS) blendedShare[pos] /= shareSum;
    }

    const snake = summarizeSnake(observationsByTeam.get(teamId) ?? []);
    const affinity = summarizeAffinity(teamPicks);

    result.set(teamId, {
      teamId,
      posBudgetShare: blendedShare,
      aggression: shrink(raw?.aggression ?? league.aggression, league.aggression, n, k),
      concentration: shrink(raw?.concentration ?? league.concentration, league.concentration, n, k),
      sampleSize: n,
      ...buildSnakeProfile(snake, leagueSnake, k),
      ...buildAffinityProfile(affinity, leagueAffinity, k),
    });
  }

  return result;
}

type SnakeProfileFields = Pick<
  TeamProfile,
  'snakePosBias' | 'snakeReach' | 'snakeReachIndex' | 'runResponse' | 'snakeSampleSize'
>;

function buildSnakeProfile(
  team: SnakeStats | null,
  league: SnakeStats | null,
  k: number
): SnakeProfileFields {
  if (!league) {
    return {
      snakePosBias: { ...NEUTRAL_PROFILE.snakePosBias },
      snakeReach: NEUTRAL_PROFILE.snakeReach,
      snakeReachIndex: NEUTRAL_PROFILE.snakeReachIndex,
      runResponse: NEUTRAL_PROFILE.runResponse,
      snakeSampleSize: 0,
    };
  }

  const n = team?.n ?? 0;

  const snakePosBias = { QB: 1, RB: 1, WR: 1, TE: 1 } as Record<AuctionPosition, number>;
  for (const pos of AUCTION_POSITIONS) {
    const leagueShare = league.posShare[pos];
    if (leagueShare <= 0) continue;
    const blended = shrink(team?.posShare[pos] ?? 0, leagueShare, n, k);
    snakePosBias[pos] = clamp(blended / leagueShare, POS_BIAS_RANGE);
  }

  const runResponse =
    league.runShare > 0
      ? clamp(
          shrink(team?.runShare ?? league.runShare, league.runShare, n, k) / league.runShare,
          RUN_RESPONSE_RANGE
        )
      : NEUTRAL_PROFILE.runResponse;

  const snakeReach = Math.max(
    0,
    shrink(team?.reach ?? league.reach, league.reach, team?.reachN ?? 0, k)
  );

  return {
    snakePosBias,
    snakeReach,
    // Most ranked players go undrafted, so the raw gap to best-available is tens of
    // ranks for everyone. The league ratio is what actually separates a best-available
    // manager from a reacher, and it is what the sim reads.
    snakeReachIndex:
      league.reach > 0 ? clamp(snakeReach / league.reach, REACH_INDEX_RANGE) : 1,
    runResponse,
    snakeSampleSize: team?.count ?? 0,
  };
}

type AffinityProfileFields = Pick<
  TeamProfile,
  'nflTeamBias' | 'rookieBias' | 'affinitySampleSize'
>;

function buildAffinityProfile(
  team: AffinityStats | null,
  league: AffinityStats | null,
  k: number
): AffinityProfileFields {
  if (!league) {
    return { nflTeamBias: {}, rookieBias: NEUTRAL_PROFILE.rookieBias, affinitySampleSize: 0 };
  }

  const nflTeamBias: Record<string, number> = {};
  for (const [nflTeam, leagueShare] of league.nflTeamShare) {
    if (leagueShare <= 0) continue;
    // Shrink on the per-franchise evidence, not the team's whole draft history.
    const cellN = team?.nflTeamCount.get(nflTeam) ?? 0;
    const blended = shrink(team?.nflTeamShare.get(nflTeam) ?? 0, leagueShare, cellN, k);
    const bias = clamp(blended / leagueShare, NFL_TEAM_BIAS_RANGE);
    // Sparse: only keep the leans worth simulating.
    if (Math.abs(bias - 1) > NFL_TEAM_BIAS_EPSILON) nflTeamBias[nflTeam] = bias;
  }

  const rookieN = team?.rookieN ?? 0;
  const rookieBias =
    league.rookieShare > 0
      ? clamp(
          shrink(team?.rookieShare ?? league.rookieShare, league.rookieShare, rookieN, k) /
            league.rookieShare,
          ROOKIE_BIAS_RANGE
        )
      : NEUTRAL_PROFILE.rookieBias;

  return { nflTeamBias, rookieBias, affinitySampleSize: team?.n ?? 0 };
}

// The team's lean toward one specific player: NFL-team bias times rookie bias.
// Shared by the auction pricing and the snake AI so both phases favour the same
// players. 1.0 means no lean either way.
export function playerAffinity(
  profile: TeamProfile,
  player: { team: string; is_rookie: boolean }
): number {
  const teamBias = profile.nflTeamBias[normalizeNflTeam(player.team)] ?? 1;
  return teamBias * (player.is_rookie ? profile.rookieBias : 1);
}
