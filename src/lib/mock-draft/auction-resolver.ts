// Sealed-bid resolution for a nomination, plus the user's counter-bid loop.
//
// Every AI team computes a hidden max willingness-to-pay (WTP). The winner is the
// highest, and the announced price is second-price + $1 (at least the league minimum) — the classic
// "you pay one dollar more than the next-highest bidder would have gone" result.
// The user then sees "Team X wins at $N" and may counter; counterBid tells the
// orchestration whether any AI would go higher.

import type { Player } from '@/server/types/player';
import { DEFAULT_ROSTER_SETTINGS, type RosterSettings } from '@/lib/roster';
import { computeWtp } from './pricing';
import { MockDraftParams, PARAMS } from './params';
import { seededRandom, seededUnit } from './rng';
import { SealedResult, TeamState, WtpBreakdown } from './types';

// Resolve a nomination among the AI teams. `aiTeams` should already exclude the
// user's team; teams without capacity contribute a $0 bid and cannot win.
export function resolveNomination(
  player: Player,
  base: number,
  aiTeams: TeamState[],
  auctionId: string,
  pickOrder: number,
  settings: RosterSettings = DEFAULT_ROSTER_SETTINGS,
  params: MockDraftParams = PARAMS
): SealedResult {
  const bids = new Map<string, WtpBreakdown>();
  for (const team of aiTeams) {
    bids.set(team.teamId, computeWtp(team, player, base, auctionId, pickOrder, settings, params));
  }

  // Rank teams by WTP, breaking ties with a seeded jitter so the same auction is
  // deterministic but ties don't always resolve to the same team id.
  const tieRng = seededRandom(auctionId, `resolve:${pickOrder}:${player.id}`);
  const ranked = [...bids.entries()]
    .map(([teamId, b]) => ({ teamId, wtp: b.wtp, tie: tieRng() }))
    .filter((r) => r.wtp > 0)
    .sort((a, b) => (b.wtp - a.wtp) || (b.tie - a.tie));

  if (ranked.length === 0) {
    // No AI team has capacity (edge case at the very end of the auction).
    return { bids, winnerTeamId: '', price: 0 };
  }

  const winner = ranked[0];
  const second = ranked[1];
  const minimumBid = Math.max(1, settings.minimumBid);
  // One solvent bidder used to mean a flat $1 no matter what the player was
  // worth. In a real room the lone bidder still opens somewhere off the player's
  // value, so take a seeded slice of the winner's own max instead. $1 stays
  // reachable — it is genuinely the cheapest price every year in this league.
  const uncontested =
    minimumBid +
    Math.round(seededUnit(auctionId, `solo:${pickOrder}:${player.id}`) * 0.5 * Math.max(0, winner.wtp - minimumBid));
  const price = second
    ? Math.max(minimumBid, Math.min(winner.wtp, second.wtp + 1))
    : Math.max(minimumBid, Math.min(winner.wtp, uncontested));

  return { bids, winnerTeamId: winner.teamId, price };
}

export type CounterResult =
  | { outbid: true; byTeamId: string; newPrice: number }
  | { outbid: false };

// Given the sealed bids and the user's bid, determine whether any AI team would
// pay more. If so, the highest such team counters at userBid + 1 and becomes the
// team-to-beat. If not, the user wins at userBid. The user's own team is not in
// `bids`, so it is never counted as a counter-bidder.
export function counterBid(
  bids: Map<string, WtpBreakdown>,
  userBid: number
): CounterResult {
  let bestTeamId = '';
  let bestWtp = 0;
  for (const [teamId, b] of bids) {
    if (b.wtp >= userBid + 1 && b.wtp > bestWtp) {
      bestWtp = b.wtp;
      bestTeamId = teamId;
    }
  }
  if (bestTeamId) {
    return { outbid: true, byTeamId: bestTeamId, newPrice: userBid + 1 };
  }
  return { outbid: false };
}
