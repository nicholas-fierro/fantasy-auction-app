import { describe, expect, it } from 'vitest';
import { buildExpertDraftComparison, buildLocalDraftComparison } from './draft-comparison';
import type { Player } from '@/server/types/player';

function player(overrides: Partial<Player>): Player {
  return {
    id: 'player', season_id: 'season', name: 'Player', team: 'AAA', position: 'RB',
    position_rank: 1, bye_week: 7, sos: 0, ecr_vs_adp: 0, rank: 1, tier: 1,
    projected_auction_value: null, is_rookie: false, sleeper_id: null, espn_id: null,
    gsis_id: null, fantasypros_id: null, created: '', updated: '', ...overrides,
  };
}

describe('draft comparison', () => {
  const first = player({ id: 'first', name: 'First', rank: 3, tier: 1, position_rank: 2 });
  const second = player({ id: 'second', name: 'Second', rank: 16, tier: 3, position_rank: 7 });

  it('uses the lower local rank as the ranking edge', () => {
    const result = buildLocalDraftComparison([first, second]);
    expect(result.source).toBe('local');
    expect(result.winnerId).toBe('first');
    expect(result.scores[0].score).toBeGreaterThan(result.scores[1].score);
  });

  it('credits the higher ecr_vs_adp as the value edge', () => {
    const valueFirst = player({ id: 'first', name: 'First', ecr_vs_adp: -4 });
    const valueSecond = player({ id: 'second', name: 'Second', ecr_vs_adp: 6 });
    const result = buildLocalDraftComparison([valueFirst, valueSecond]);
    const reason = result.reasons.find((r) => r.label === 'ECR vs. ADP');
    expect(reason?.winnerId).toBe('second');
    expect(reason?.detail).toBe('+6 versus -4');
  });

  it('treats an ecr_vs_adp of 0 as a real value, not missing', () => {
    const valueFirst = player({ id: 'first', name: 'First', ecr_vs_adp: 0 });
    const valueSecond = player({ id: 'second', name: 'Second', ecr_vs_adp: -3 });
    const result = buildLocalDraftComparison([valueFirst, valueSecond]);
    const reason = result.reasons.find((r) => r.label === 'ECR vs. ADP');
    expect(reason?.winnerId).toBe('first');
    expect(reason?.detail).toBe('0 versus -3');
  });

  it('breaks a full ranking tie with the higher ecr_vs_adp', () => {
    const valueFirst = player({ id: 'first', name: 'First', ecr_vs_adp: 2 });
    const valueSecond = player({ id: 'second', name: 'Second', ecr_vs_adp: 5 });
    const result = buildLocalDraftComparison([valueFirst, valueSecond]);
    expect(result.winnerId).toBe('second');
    expect(result.scores[1].score).toBeGreaterThan(result.scores[0].score);
  });

  it('counts only complete, non-tied expert ballots', () => {
    const result = buildExpertDraftComparison([first, second], [
      { expertId: 'a', playerRanks: { first: 1, second: 4 } },
      { expertId: 'b', playerRanks: { first: 6, second: 2 } },
      { expertId: 'c', playerRanks: { first: 3, second: 3 } },
      { expertId: 'd', playerRanks: { first: 3 } },
    ]);
    expect(result.totalExperts).toBe(2);
    expect(result.votes).toEqual({ first: 1, second: 1 });
    expect(result.winnerId).toBeNull();
  });
});
