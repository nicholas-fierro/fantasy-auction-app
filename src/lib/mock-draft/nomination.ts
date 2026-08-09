// AI nomination strategy: when it's an AI team's turn to put a player up for
// auction, decide who. Two flavors, chosen by a seeded coin so the same auction
// replays identically but different auctions differ:
//   - drain: throw out a high-value player the nominating team does NOT want, to
//     make rivals spend their budgets.
//   - target: nominate a player the team actually wants (weighted toward, but not
//     always, its top need — feels human).

import { DEFAULT_ROSTER_SETTINGS, type RosterSettings } from '@/lib/roster';
import { MockDraftParams, PARAMS } from './params';
import { seededRandom, weightedPick } from './rng';
import { computeNeed } from './pricing';
import { NominationChoice, RankedPlayer, TeamState } from './types';

// The consideration-set size and the drain probability are `params.candidatePool`
// and `params.drainProbability` (see params.ts).

// Choose a nomination for `nominatingTeam` from the available players (each with a
// precomputed league base value). `available` should be sorted or unsorted — this
// takes the top CANDIDATE_POOL by base internally. Assumes `available` is
// non-empty (caller guarantees at least one draftable player remains).
export function chooseNomination(
  nominatingTeam: TeamState,
  available: RankedPlayer[],
  auctionId: string,
  pickOrder: number,
  settings: RosterSettings = DEFAULT_ROSTER_SETTINGS,
  params: MockDraftParams = PARAMS
): NominationChoice {
  const candidates = [...available]
    .sort((a, b) => b.base - a.base)
    .slice(0, Math.max(1, Math.round(params.candidatePool)));

  const rng = seededRandom(auctionId, `nom:${pickOrder}:${nominatingTeam.teamId}`);
  const drain = rng() < params.drainProbability;

  if (drain) {
    // Highest-value player the team least needs: maximize base * (1.3 - need),
    // where need ∈ [0.25, 1.25]. Players the team wants (high need) score lower.
    let best = candidates[0];
    let bestScore = -Infinity;
    for (const c of candidates) {
      const need = computeNeed(nominatingTeam, c.player, settings, params);
      const score = c.base * (1.3 - need);
      if (score > bestScore) {
        bestScore = score;
        best = c;
      }
    }
    return { player: best.player, base: best.base, reason: 'drain' };
  }

  // Target: weighted sample over need * base, so the team usually nominates
  // something it wants but not always its single top target.
  const weights = candidates.map(
    (c) => computeNeed(nominatingTeam, c.player, settings, params) * c.base
  );
  const chosen = weightedPick(candidates, weights, rng());
  return { player: chosen.player, base: chosen.base, reason: 'target' };
}
