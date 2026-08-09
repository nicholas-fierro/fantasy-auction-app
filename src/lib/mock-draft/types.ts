// Shared types for the mock-draft simulation engine. Kept in one module so the
// pricing / nomination / resolver / snake modules can share type shapes without
// importing each other's runtime code (avoids cycles). Nothing here is runtime —
// pure type declarations. The engine as a whole is pure TS: no React, no PB SDK.

import type { Player } from '@/server/types/player';

// The positions the league actually bids on in the auction phase. K/DST are
// filled in the snake phase and get no dollar profile.
export type AuctionPosition = 'QB' | 'RB' | 'WR' | 'TE';

export const AUCTION_POSITIONS: readonly AuctionPosition[] = ['QB', 'RB', 'WR', 'TE'];

export function isAuctionPosition(pos: string): pos is AuctionPosition {
  return pos === 'QB' || pos === 'RB' || pos === 'WR' || pos === 'TE';
}

// A team's derived drafting tendencies, computed from that team's picks in past
// official auctions and shrunk toward the league average. See profiles.ts.
//
// Three groups: auction stats (from priced picks), snake stats (from the $0
// snake-round picks, decay-weighted toward the early rounds), and affinity stats
// (from every pick, since a homer or rookie lean shows up in both phases).
export interface TeamProfile {
  teamId: string;
  // Fraction of auction budget the team historically spends per position.
  // Sums to ~1 across QB/RB/WR/TE.
  posBudgetShare: Record<AuctionPosition, number>;
  // Price paid relative to league value. 1.0 = pays the market price; 1.15 =
  // overpays 15%; 0.9 = value-hunts.
  aggression: number;
  // Share of total auction spend concentrated in the team's two priciest buys
  // (a stars-and-scrubs vs. balanced-roster signal). 0–1.
  concentration: number;
  // Number of priced picks backing the auction stats (before shrinkage).
  sampleSize: number;

  // How much more/less often the team spends early snake picks on a position than
  // the league does. 1.0 = league-typical, 1.5 = takes 50% more of them early.
  snakePosBias: Record<AuctionPosition, number>;
  // Average number of ranks past the best player still on the board that this team
  // drafts. Reported for the reader; the floor is structurally high (most ranked
  // players go undrafted), so what separates managers is the ratio below.
  snakeReach: number;
  // `snakeReach` relative to the league's, which is what the sim reads. 1.0 = drafts
  // as close to best-available as the league does, 1.3 = reaches 30% further.
  snakeReachIndex: number;
  // Response to positional runs. >1 chases a run, <1 zags against it, 1 ignores it.
  runResponse: number;
  // Number of snake picks backing the snake stats (before shrinkage).
  snakeSampleSize: number;

  // Per-NFL-team draft lean, sparse: only teams the manager visibly over- or
  // under-drafts appear; everything else is an implicit 1.0.
  nflTeamBias: Record<string, number>;
  // Appetite for rookies relative to the league. 1.0 = league-typical.
  rookieBias: number;
  // Number of picks backing the affinity stats (before shrinkage).
  affinitySampleSize: number;
}

// A team's live state during a mock draft, assembled from its picks-so-far.
// Everything the pricing / nomination / snake logic needs about one team.
export interface TeamState {
  teamId: string;
  profile: TeamProfile;
  // From calculateBudgetSummary (roster.ts) — already reserves $1 per unfilled
  // paid slot, so clamping WTP to maxBid keeps the endgame legal.
  maxBid: number;
  remainingBudget: number;
  remainingAuctionPicks: number;
  totalPicks: number;
  // Dollars spent per position (auction picks only).
  spentByPosition: Record<string, number>;
  // Players rostered per position, both phases. Drives positional roster caps and
  // the diminishing return on stacking more depth at a position already covered.
  countByPosition: Record<string, number>;
  // Count of filled dedicated starter slots per position (excludes FLEX).
  filledStarters: Record<string, number>;
  // Number of filled FLEX starter slots.
  filledFlexStarters: number;
  // Count of unfilled required starter slots (QB/RB/WR/TE/K/DST + FLEX).
  unfilledRequiredStarters: number;
}

// A player paired with its precomputed league base value, so nomination and
// resolution don't recompute estimates per team.
export interface RankedPlayer {
  player: Player;
  base: number;
}

// The multiplicative breakdown behind a team's hidden willingness-to-pay.
// Surfaced (only after a pick commits) in the "why this price" UI.
export interface WtpBreakdown {
  base: number;
  aggression: number;
  need: number;
  posBudget: number;
  // Combined NFL-team and rookie lean for this player (1.0 = no lean).
  affinity: number;
  jitter: number;
  cap: number; // lower of the team's legal maxBid and the market-relative ceiling
  wtp: number;
}

export interface NominationChoice {
  player: Player;
  base: number;
  reason: 'drain' | 'target';
}

export interface SealedResult {
  // Hidden per-team max willingness-to-pay for the nominated player.
  bids: Map<string, WtpBreakdown>;
  // '' when no AI team has capacity (edge case at the very end of the auction).
  winnerTeamId: string;
  price: number;
}

export type MockPhase = 'auction' | 'snake' | 'complete';

export interface MockDraftState {
  phase: MockPhase;
  // The team due to nominate next (auction phase) or pick next (snake phase).
  currentTeamId: string | null;
  nextPickOrder: number;
}
