// Hidden willingness-to-pay (WTP) for a team on a nominated player. Combines the
// league market price with the team's profile, its roster need, its positional
// budget, and seeded jitter, then clamps to the team's legal maxBid. Returns an
// explainable breakdown so the UI can show "why this price" after a pick commits.

import type { Player } from '@/server/types/player';
import { DEFAULT_ROSTER_SETTINGS, type RosterSettings } from '@/lib/roster';
import { estimateValue, HistoryIndex } from '@/lib/estimated-value';
import { playerAffinity } from './profiles';
import { MockDraftParams, PARAMS } from './params';
import { seededNormal, seededUniform } from './rng';
import { isAuctionPosition, TeamState, WtpBreakdown } from './types';

// The league estimate already prices positional scarcity and elite talent. The
// tendency multipliers may move a team below that market or modestly above it,
// but must not compound into implausible $110+ opening bids on an ~$80 player.
//
// This is a per-team seeded range, not a constant, and that matters more than it
// looks. As a constant it was a shared integer: for an elite player the factor
// stack lands above the ceiling for ~90% of jitter draws, so most teams clamped to
// the SAME `round(base * 1.1)`, and second-price + $1 between two teams sitting on
// the same value C returns exactly C. Every bit of randomness in the auction was
// discarded at that line — the league's #1 RB cleared at an identical dollar in
// every mock draft ever run. Randomizing the ceiling per team keeps the guard
// (nobody bids far above market) while letting the runner-up actually vary.
//
// The range itself is `params.ceilMin` / `params.ceilMax` (see params.ts). Both
// ENDS matter, because at the top of the board this range is the only thing that
// prices anything. The factor stack sits 1.3-1.5x above the model value there, so
// all twelve bidders clamp and the clearing price is the second-highest of twelve
// draws from that interval — i.e. ceilMin + (ceilMax - ceilMin) * 11/13, plus the
// spread the draws provide. A ceilMin of exactly 1.0 therefore does not mean "a
// team may bid up to the model value"; it means an elite player can never clear
// BELOW it, which put a deterministic +8.5% on the whole elite tier. Real rooms
// pay a median 0.99x the model at ranks 1-12 and miss both ways (measured across
// 2019-2025 and one outside board — see BOUNDS in scripts/fit-mock-draft-params.ts),
// so the interval has to straddle 1.0 rather than start there.

export function getStarterRequirements(
  settings: RosterSettings = DEFAULT_ROSTER_SETTINGS
): { dedicated: Record<string, number>; flex: number } {
  const dedicated: Record<string, number> = {};
  let flex = 0;
  for (const pos of settings.starterPositions) {
    if (pos === 'FLEX') flex++;
    else dedicated[pos] = (dedicated[pos] ?? 0) + 1;
  }
  return { dedicated, flex };
}

const FLEX_POSITIONS = new Set(['RB', 'WR', 'TE']);

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

// Last-resort value when a player has neither a comp-based estimate nor a
// projected value (e.g. a deep player the league has never priced). A smooth
// decreasing curve by overall rank, floored at $1.
export function rankFallback(rank: number): number {
  if (!rank || rank <= 0 || rank > 200) return 1;
  return Math.max(1, Math.round(55 * Math.pow(0.965, rank - 1)));
}

// How far the room's read on a player drifts from the comp value, as a relative
// standard deviation by overall rank. Measured off this league's own 2018-2025
// official auctions: within-year price residual against a local rank curve runs
// 0.06 at the very top of the board, ~0.22 in the teens, ~0.50 in the 25-48
// range, and far wider below that. The deep tail is deliberately damped (the raw
// figure is ~1.8, where a $4 player going $15 is unremarkable) — full fidelity
// there just makes late nominations feel chaotic.
function marketNoiseSd(rank: number): number {
  if (rank <= 0) return 0.45;
  if (rank <= 6) return 0.05;
  if (rank <= 12) return 0.11;
  if (rank <= 24) return 0.2;
  if (rank <= 48) return 0.45;
  if (rank <= 84) return 0.8;
  if (rank <= 144) return 0.55;
  return 0;
}

// Where the room's read SITS relative to the comp value, in log space.
//
// This was 0 at every rank, i.e. the league was assumed to pay the model value on
// average and to miss symmetrically. It does not. Measured over the 2020-2025
// official drafts (502 priced picks), mean log(price paid / model value) runs:
//
//   ranks 1-6  -0.004 | 7-12 -0.033 | 13-24 -0.014 | 25-48 +0.026
//   ranks 49-84 +0.208 | 85+ +0.407
//
// The top of the board is priced honestly; from the middle down the room pays a
// growing premium — 24.5% of picks at ranks 25-48 and 49.5% at ranks 49-84 go for
// more than 1.25x the model value. With a mean of 0 and a symmetric multiplier the
// sim could not produce those overpays at the right rate, which is why a mid-board
// player the league loves cleared below his projection in every mock.
function marketNoiseMean(rank: number): number {
  if (rank <= 0) return 0.1;
  if (rank <= 6) return 0;
  if (rank <= 12) return -0.03;
  if (rank <= 24) return -0.01;
  if (rank <= 48) return 0.03;
  if (rank <= 84) return 0.21;
  if (rank <= 144) return 0.41;
  return 0;
}

// How many dollars the noise may move a player off its comp value. Scales with
// `base` so it never binds on elite players (whose relative sd is tiny anyway),
// while still letting a $4 sleeper reach ~$10 — a real late-auction overpay —
// instead of the 4x blowups the unclamped history would produce.
function marketNoiseCap(base: number): number {
  return Math.max(12, base * 0.35);
}

// The dollar cap alone is not enough at the bottom of the board: $12 on a $1
// waiver-fodder base is a 12x multiplier, which floats rank-700 players into the
// nomination pool and gets them bought ahead of real starters. The relative clamp
// keeps the noise from reordering the board wholesale; between the two, the
// tighter one wins at every price level.
const MARKET_NOISE_MIN_MULTIPLIER = 0.5;
const MARKET_NOISE_MAX_MULTIPLIER = 2.5;

// The league's read on this player in THIS auction. Seeded on the player alone
// (not the pick), so every team prices him off the same number all draft long and
// a refresh reproduces it — one market level per player per auction, which is
// what varies between real drafts. Without this, `base` is a pure function of the
// history index and the board, i.e. identical in every session.
export function marketFactor(
  auctionId: string,
  player: Player,
  base: number,
  params: MockDraftParams = PARAMS
): number {
  if (!auctionId || base <= 0) return 1;
  const sd = marketNoiseSd(player.rank);
  // Lognormal, not `1 + z*sd`. Two reasons, both about overpays:
  //   - A price is a positive multiple of a value, so the natural error is
  //     multiplicative. `1 + z*sd` can go negative at sd 0.8 and has to be clamped
  //     back, which eats the very tail that produces a bidding war.
  //   - exp() is right-skewed, so an overpay is bigger in dollars than the matching
  //     underpay is. The league's own residual is right-skewed (+0.42 overall),
  //     and the symmetric form could not reproduce that.
  // `marketMeanScale` 0 restores the old zero-mean behaviour.
  const raw = Math.exp(
    marketNoiseMean(player.rank) * params.marketMeanScale +
      seededNormal(auctionId, `market:${player.id}`) * sd
  );
  const cap = marketNoiseCap(base);
  return clamp(
    raw,
    Math.max(MARKET_NOISE_MIN_MULTIPLIER, (base - cap) / base),
    Math.min(MARKET_NOISE_MAX_MULTIPLIER, (base + cap) / base)
  );
}

// A manual, per-player multiplier on the league market price: "whatever the model
// says, this room likes him more than that."
//
// This is deliberately NOT fitted, and it is the only knob here that isn't. The
// model has no feature that predicts a specific player's hype: `ecr_vs_adp`, the
// obvious candidate, correlates 0.036 with price-over-model on the only season
// that carries both it and a real draft (84 picks, 2025), and its apparent signal
// is a rank confound. A manager knows things about his own league that eight
// drafts cannot contain, so that knowledge enters as an explicit input rather than
// as a fake feature. 1.0 = no opinion.
export type MarketNudges = ReadonlyMap<string, number>;

const NUDGE_MIN = 0.4;
const NUDGE_MAX = 2.5;

// The league market price for a player: comp-based estimate first, then the
// player's normalized projected value, then a rank fallback, shifted by this
// auction's market read and by any manual nudge. Never below $1 for an
// auction-relevant player.
// `auctionId` is optional: omit it for the raw, un-noised comp value.
export function computeBase(
  index: HistoryIndex,
  draftYear: number,
  player: Player,
  auctionId = '',
  params: MockDraftParams = PARAMS,
  nudges?: MarketNudges
): number {
  const est = estimateValue(index, player.position, player.position_rank, player.rank, draftYear);
  let base: number;
  if (est && est.estimate > 0) base = est.estimate;
  else if (player.projected_auction_value && player.projected_auction_value > 0) {
    base = player.projected_auction_value;
  } else base = rankFallback(player.rank);

  // The nudge multiplies the value the room is reading, so it moves the centre of
  // the price distribution and leaves the spread around it intact — a hyped player
  // should be dearer AND still vary, not pinned to a new number.
  const nudge = clamp(nudges?.get(player.id) ?? 1, NUDGE_MIN, NUDGE_MAX);
  base *= nudge;

  return Math.max(1, Math.round(base * marketFactor(auctionId, player, base, params)));
}

// Positions no manager in this league spends auction dollars to double up on.
//
// The auction phase had no positional cap of any kind — only `computeNeed` and
// `computePosBudgetFactor`, which merely FADE a team's willingness to pay. A fade
// is not a wall, so a team that valued a second quarterback enough could buy one.
// The league never has: across 96 team-seasons (2018-2025) nobody has ever bought
// two QBs with auction money, and exactly one team ever bought two TEs. 77% of
// rosters end with two QBs and half end with two TEs — the backup always comes
// out of the snake rounds, which is where the cap in snake-ai.ts still allows it.
//
// The limit is the number of DEDICATED starter slots, so a league configured for
// two starting quarterbacks still gets to buy two.
const AUCTION_ONE_PER_STARTER = new Set(['QB', 'TE']);

function atAuctionPositionCap(
  team: TeamState,
  player: Player,
  settings: RosterSettings
): boolean {
  if (!AUCTION_ONE_PER_STARTER.has(player.position)) return false;
  const dedicated = getStarterRequirements(settings).dedicated[player.position] ?? 0;
  // A league that starts none of this position has no rule to apply here.
  if (dedicated <= 0) return false;
  return (team.countByPosition[player.position] ?? 0) >= dedicated;
}

// Need weights that stay fixed. They are not free parameters because the data
// cannot separate them from the two that are (`needElite`, `needDepth`): a tier-3/4
// starter and an open FLEX are a small minority of the priced picks.
const NEED_TIER34 = 1.1;
const NEED_OPEN_FLEX = 0.8;
const NEED_MIN = 0.25;
const NEED_MAX = 1.25;
// The depth weight once the position's budget share is already spent, and the
// `needDepth` value it is expressed relative to.
const NEED_DEPTH_SPENT_DEFAULT = 0.25;
const NEED_DEPTH_DEFAULT = 0.55;

// Roster-need multiplier (0.25–1.25 by default). Highest when the player fills an open
// dedicated starter slot (bumped further for scarce elite tiers); moderate for an
// open FLEX; low once the position's starters are filled, and lowest once the
// team has already spent its historical budget share on the position.
export function computeNeed(
  team: TeamState,
  player: Player,
  settings: RosterSettings = DEFAULT_ROSTER_SETTINGS,
  params: MockDraftParams = PARAMS
): number {
  const pos = player.position;
  const requirements = getStarterRequirements(settings);
  const required = requirements.dedicated[pos] ?? 0;
  const filled = team.filledStarters[pos] ?? 0;
  const hasOpenStarter = filled < required;

  // The over-budget depth weight rides on `needDepth` rather than being free on its
  // own, so the fit cannot invert the two. The ratio form keeps the default exact:
  // needDepth / NEED_DEPTH_DEFAULT is precisely 1 when nothing has been fitted.
  const needDepthSpent = NEED_DEPTH_SPENT_DEFAULT * (params.needDepth / NEED_DEPTH_DEFAULT);

  let need: number;
  if (hasOpenStarter) {
    need = 1.0;
    if (player.tier > 0 && player.tier <= 2) need = params.needElite;
    else if (player.tier > 0 && player.tier <= 4) need = NEED_TIER34;
  } else if (FLEX_POSITIONS.has(pos) && team.filledFlexStarters < requirements.flex) {
    need = NEED_OPEN_FLEX;
  } else {
    // Starters (and FLEX, if eligible) are covered — depth only. Fade harder once
    // the team has spent its historical budget share on this position.
    const share = isAuctionPosition(pos) ? team.profile.posBudgetShare[pos] : 0;
    const posBudget = share * settings.budget;
    const spent = team.spentByPosition[pos] ?? 0;
    need = spent >= posBudget ? needDepthSpent : params.needDepth;
  }
  // Concentrated (stars-and-scrubs) teams lean harder into elite tiers and fade
  // depth; balanced teams do the inverse. Keeping this inside the need factor
  // preserves the documented WTP formula and its 0.25–1.25 bounds.
  const isElite = (player.tier > 0 && player.tier <= 2) || (player.rank > 0 && player.rank <= 24);
  const isDepth = player.tier >= 5 || player.rank > 72;
  const concentrationSignal = isElite ? 0.5 : isDepth ? -0.5 : 0;
  need *= 1 + (team.profile.concentration - 0.4) * concentrationSignal;

  // The bounds follow the parameters they bracket, otherwise raising `needElite`
  // would be clamped straight back to the value it replaced.
  return clamp(need, Math.min(NEED_MIN, needDepthSpent), Math.max(NEED_MAX, params.needElite));
}

// A soft cap that fades a team's WTP as it approaches its historical spend on the
// position — a tendency, not a hard wall (factor floored, never 0).
//
// `base` already prices positional scarcity: the comps behind it come from this
// league's own history, where TEs and QBs go cheap. Applying the full share cap to
// a team's FIRST dedicated starter at a position therefore double-counts that —
// with TE at an ~8% share ($16), the #1 TE's factor landed near 0.47 and the top
// tight ends cleared at ~0.65x market. So the cap only bites hard on depth buys.
const STARTER_POS_BUDGET_FLOOR = 0.85;

function computePosBudgetFactor(
  team: TeamState,
  player: Player,
  base: number,
  settings: RosterSettings,
  params: MockDraftParams
): number {
  if (!isAuctionPosition(player.position) || base <= 0) return 1;
  const share = team.profile.posBudgetShare[player.position];
  const posBudget = share * settings.budget;
  const spent = team.spentByPosition[player.position] ?? 0;
  const remainingPosBudget = Math.max(0, posBudget - spent);
  const requirements = getStarterRequirements(settings).dedicated;
  const fillsOpenStarter =
    (team.filledStarters[player.position] ?? 0) < (requirements[player.position] ?? 0);
  const floor = fillsOpenStarter ? STARTER_POS_BUDGET_FLOOR : 0.3;
  return clamp((remainingPosBudget * params.posBudgetSlack) / base, floor, 1.0);
}

// The team's hidden max willingness-to-pay for `player` at `base` league value.
// Deterministic given (auctionId, pickOrder, team, player) via seeded jitter.
export function computeWtp(
  team: TeamState,
  player: Player,
  base: number,
  auctionId: string,
  pickOrder: number,
  settings: RosterSettings = DEFAULT_ROSTER_SETTINGS,
  params: MockDraftParams = PARAMS
): WtpBreakdown {
  // A team with no paid slots left cannot bid, and neither can one that already
  // owns its allotment of a position nobody pays to double up on.
  if (
    team.remainingAuctionPicks <= 0 ||
    team.maxBid <= 0 ||
    atAuctionPositionCap(team, player, settings)
  ) {
    return {
      base,
      aggression: team.profile.aggression,
      need: 0,
      posBudget: 0,
      affinity: 1,
      jitter: 1,
      cap: team.maxBid,
      wtp: 0,
    };
  }

  const aggression = team.profile.aggression;
  const need = computeNeed(team, player, settings, params);
  const posBudget = computePosBudgetFactor(team, player, base, settings, params);
  const affinity = playerAffinity(team.profile, player);
  const jitter = seededUniform(
    auctionId,
    `wtp:${pickOrder}:${team.teamId}:${player.id}`,
    params.jitterMin,
    params.jitterMax
  );

  const ceilingMultiplier = seededUniform(
    auctionId,
    `ceil:${pickOrder}:${team.teamId}:${player.id}`,
    params.ceilMin,
    params.ceilMax
  );

  const raw = base * aggression * need * posBudget * affinity * jitter;
  const minimumBid = Math.max(1, settings.minimumBid);
  const marketCeiling = Math.max(minimumBid, Math.round(base * ceilingMultiplier));
  // The room's hard ceiling on any one player. Capping the WTP is enough to cap the
  // PRICE: the clearing price is min(winner.wtp, second.wtp + 1), which can never
  // exceed the winner's own capped WTP.
  const roomCeiling =
    params.maxPriceShare > 0
      ? Math.max(minimumBid, Math.round(settings.budget * params.maxPriceShare))
      : Infinity;
  const cap = Math.min(team.maxBid, marketCeiling, roomCeiling);
  const wtp = cap < minimumBid ? 0 : clamp(Math.round(raw), minimumBid, cap);

  return { base, aggression, need, posBudget, affinity, jitter, cap, wtp };
}
