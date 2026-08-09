// The one runnable check that the behavior metrics are not lying to us.
//
// A metric that reports "the sim matched the real draft" when it did not is worse
// than no metric, because it ends the investigation. So: score a synthetic draft
// against itself (every number must be perfect), against a shuffled copy (every
// number must fall to chance), and against a disjoint player set (coverage must
// say so rather than the price error absorbing it).

import { describe, it, expect } from 'vitest';
import type { FantasyTeam } from '@/server/types/fantasy-team';
import { gini, pearson, scoreDraft, type ScoredPick } from './mock-draft-score';

const teams: FantasyTeam[] = [
  { id: 'A', name: 'A', draft_order: 1, created: '', updated: '' },
  { id: 'B', name: 'B', draft_order: 2, created: '', updated: '' },
];

// Team A is a stars-and-scrubs RB buyer, team B spreads its money over WRs.
const actual: ScoredPick[] = [
  { teamId: 'A', playerId: 'p1', price: 60, position: 'RB', rank: 1 },
  { teamId: 'A', playerId: 'p2', price: 30, position: 'RB', rank: 8 },
  { teamId: 'A', playerId: 'p3', price: 10, position: 'WR', rank: 30 },
  { teamId: 'B', playerId: 'p4', price: 25, position: 'WR', rank: 5 },
  { teamId: 'B', playerId: 'p5', price: 25, position: 'WR', rank: 14 },
  { teamId: 'B', playerId: 'p6', price: 25, position: 'QB', rank: 40 },
  // All four scored positions have to vary across the two teams, otherwise the
  // cross-manager correlation for the flat one is 0 by definition and the
  // reproduce-the-draft check cannot read as a clean 1.
  { teamId: 'A', playerId: 'p9', price: 10, position: 'TE', rank: 25 },
  // Snake picks carry price 0.
  { teamId: 'A', playerId: 'p7', price: 0, position: 'TE', rank: 60 },
  { teamId: 'B', playerId: 'p8', price: 0, position: 'K', rank: 200 },
];

function swapTeams(picks: ScoredPick[]): ScoredPick[] {
  return picks.map((p) => ({ ...p, teamId: p.teamId === 'A' ? 'B' : 'A' }));
}

describe('mock-draft-score', () => {
  it('is perfect when the sim reproduces the real draft', () => {
    const card = scoreDraft(actual, [actual, actual], teams, 2025);
    expect(card.coverage).toBe(1);
    expect(card.softAssign).toBe(1);
    expect(card.softAssignConditional).toBe(1);
    expect(card.priceMae).toBe(0);
    expect(card.priceSignedError).toBe(0);
    expect(card.sortedCurveMae).toBe(0);
    expect(card.posShareMae).toBe(0);
    expect(card.posShareCorr).toBeCloseTo(1, 6);
    expect(card.snakePosShareMae).toBe(0);
    expect(card.snakeSoftAssign).toBe(1);
    expect(card.snakeRosterL1).toBe(0);
  });

  it('falls to zero assignment when every player lands on the wrong team', () => {
    const card = scoreDraft(actual, [swapTeams(actual)], teams, 2025);
    // Same players at the same prices, so selection and prices stay perfect...
    expect(card.coverage).toBe(1);
    expect(card.priceMae).toBe(0);
    // ...and only the assignment collapses. With two teams, all-wrong is 0.
    expect(card.softAssign).toBe(0);
    expect(card.snakeSoftAssign).toBe(0);
    // The share table is inverted, so the cross-manager correlation is -1.
    expect(card.posShareCorr).toBeLessThan(0);
  });

  it('averages assignment over seeds instead of rounding it to a hit or a miss', () => {
    const card = scoreDraft(actual, [actual, swapTeams(actual)], teams, 2025);
    expect(card.softAssign).toBeCloseTo(0.5, 10);
  });

  it('reports missing players as coverage, never as a price error', () => {
    const disjoint: ScoredPick[] = actual.map((p) => ({ ...p, playerId: `x${p.playerId}` }));
    const card = scoreDraft(actual, [disjoint], teams, 2025);
    expect(card.coverage).toBe(0);
    // Nothing is in the intersection, so there is no price evidence at all — and
    // crucially the MAE is 0 for "no data", not a huge number from imputed $0.
    expect(card.buckets).toHaveLength(0);
    expect(card.priceMae).toBe(0);
    // The curve metric still works: it needs no player matching.
    expect(card.sortedCurveMae).toBe(0);
  });

  it('scores partial coverage on the overlap only', () => {
    // Half the board matches; the matching half is priced $5 too high.
    const half: ScoredPick[] = [
      { teamId: 'A', playerId: 'p1', price: 65, position: 'RB', rank: 1 },
      { teamId: 'A', playerId: 'p2', price: 35, position: 'RB', rank: 8 },
      { teamId: 'B', playerId: 'zz1', price: 25, position: 'WR', rank: 5 },
      { teamId: 'B', playerId: 'zz2', price: 25, position: 'WR', rank: 14 },
      { teamId: 'B', playerId: 'zz3', price: 25, position: 'QB', rank: 40 },
      { teamId: 'A', playerId: 'zz4', price: 10, position: 'WR', rank: 30 },
    ];
    const card = scoreDraft(actual, [half], teams, 2025);
    expect(card.coverage).toBeCloseTo(2 / 7, 10);
    expect(card.priceMae).toBe(5);
    expect(card.priceSignedError).toBe(5);
  });

  it('computes gini and pearson the usual way', () => {
    expect(gini([10, 10, 10, 10])).toBeCloseTo(0, 10);
    expect(gini([0, 0, 0, 100])).toBeGreaterThan(0.7);
    expect(pearson([1, 2, 3], [2, 4, 6])).toBeCloseTo(1, 10);
    expect(pearson([1, 2, 3], [3, 2, 1])).toBeCloseTo(-1, 10);
    // A constant series cannot correlate with anything; 0 is the honest answer.
    expect(pearson([1, 1, 1], [1, 2, 3])).toBe(0);
  });
});
