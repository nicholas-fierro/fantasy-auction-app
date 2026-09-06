import { describe, expect, it } from 'vitest';
import type { RecordModel } from 'pocketbase';
import { compareBoardPlayers, deriveAdp } from '@/lib/adp';
import { rankingFields } from '@/server/lib/import-core';
import { mapSeasonRecord, mapSeasonToPlayer, mapPickRecord, mapWatchlistRecord } from '@/lib/pb-mappers';
import { buildLocalDraftComparison } from '@/lib/draft-comparison';

const base = { id: 'season', player_id: 'player', rank: 20, ecr_vs_adp: 4,
  ecr_vs_adp_known: true, rank_ppr: 10, ecr_vs_adp_ppr: 0,
  ecr_vs_adp_ppr_known: true } as unknown as RecordModel;

describe('derived ADP', () => {
  it.each([[20, 5, 25], [20, -5, 15], [20, 0, 20], [20, 2.5, 22.5]])
    ('derives rank %s plus delta %s', (rank, delta, expected) => {
      expect(deriveAdp(rank, delta)).toBe(expected);
    });
  it.each([
    [20, null], [20, undefined], [null, 0], [undefined, 0], [0, 4], [-1, 4],
    [20, NaN], [NaN, 2], [20, Infinity], [Infinity, 0], [20, -20], [20, -21],
    [Number.MAX_VALUE, Number.MAX_VALUE],
  ])('rejects missing or invalid inputs (%s, %s)', (rank, delta) => {
    expect(deriveAdp(rank, delta)).toBeNull();
  });
  it('derives each selected scoring board without fallback', () => {
    const half = mapSeasonToPlayer(base, 'half');
    const ppr = mapSeasonToPlayer(base, 'ppr');
    expect(deriveAdp(half.rank, half.ecr_vs_adp)).toBe(24);
    expect(deriveAdp(ppr.rank, ppr.ecr_vs_adp)).toBe(10);
    expect(mapSeasonToPlayer({ ...base, ecr_vs_adp_ppr_known: false }, 'ppr').ecr_vs_adp).toBeNull();
  });
  it.each([false, undefined])('does not treat unproven zero as known (%s)', known => {
    expect(mapSeasonRecord({ ...base, ecr_vs_adp: 0, ecr_vs_adp_known: known }).ecr_vs_adp).toBeNull();
  });
  it.each([null, undefined, NaN, Infinity, '0'])('rejects invalid marked-known storage (%s)', delta => {
    expect(mapSeasonRecord({ ...base, ecr_vs_adp: delta }).ecr_vs_adp).toBeNull();
  });
  it('preserves missing delta in hydrated watchlist and picks', () => {
    const season = { ...base, ecr_vs_adp_ppr_known: false };
    expect(mapPickRecord(base, season, 'ppr').player.ecr_vs_adp).toBeNull();
    expect(mapWatchlistRecord(base, season, 'ppr').player.ecr_vs_adp).toBeNull();
  });
});

describe('delta imports', () => {
  it.each(['half', 'ppr'] as const)('preserves known zero on %s and clears missing/blank/invalid delta', format => {
    const field = format === 'ppr' ? 'ecr_vs_adp_ppr' : 'ecr_vs_adp';
    for (const raw of ['0', '+0', ' 0 ', '-3', '+4']) {
      const fields = rankingFields({ RK: '30', 'ECR VS. ADP': raw }, new Set(['RK', 'ECR VS. ADP']), format);
      expect(fields[field]).toBe(Number(raw));
      expect(fields[`${field}_known`]).toBe(true);
      const mapped = mapSeasonToPlayer({ ...base, ...fields }, format);
      expect(deriveAdp(mapped.rank, mapped.ecr_vs_adp)).toBe(30 + Number(raw));
    }
    for (const raw of ['', ' ', 'N/A', '3oops', 'Infinity', '1.5', null, undefined]) {
      const fields = rankingFields({ RK: '30', 'ECR VS. ADP': raw }, new Set(['RK', 'ECR VS. ADP']), format);
      expect(fields).toMatchObject({ [field]: 0, [`${field}_known`]: false });
      expect(mapSeasonToPlayer({ ...base, ...fields }, format).ecr_vs_adp).toBeNull();
    }
    const absent = rankingFields({ RK: '30' }, new Set(['RK']), format);
    expect(absent).toMatchObject({ [field]: 0, [`${field}_known`]: false });
    expect(mapSeasonToPlayer({ ...base, ...absent }, format).ecr_vs_adp).toBeNull();
    expect(absent).not.toHaveProperty(format === 'ppr' ? 'ecr_vs_adp_known' : 'ecr_vs_adp_ppr_known');
  });
});

describe('board sorting', () => {
  const players = [
    { id: 'missing', rank: 1, ecr_vs_adp: null },
    { id: 'later', rank: 2, ecr_vs_adp: 20 },
    { id: 'earlier', rank: 10, ecr_vs_adp: 0 },
    { id: 'invalid', rank: 0, ecr_vs_adp: 0 },
  ];
  it.each(['asc', 'desc'] as const)('keeps unavailable ADP last (%s)', direction => {
    const sorted = [...players].sort((a, b) => compareBoardPlayers(a, b, { column: 'adp', direction }));
    expect(sorted.slice(0, 2).map(p => p.id)).toEqual(direction === 'asc' ? ['earlier', 'later'] : ['later', 'earlier']);
    expect(new Set(sorted.slice(2).map(p => p.id))).toEqual(new Set(['missing', 'invalid']));
  });
  it('restores ECR order', () => {
    expect([...players].sort((a, b) => compareBoardPlayers(a, b, { column: 'rank', direction: 'asc' })).map(p => p.id))
      .toEqual(['missing', 'later', 'earlier', 'invalid']);
  });
});

it('does not award a delta comparison edge to unknown data', () => {
  const first = { ...mapSeasonToPlayer(base), id: 'first', ecr_vs_adp: null };
  const second = { ...first, id: 'second', ecr_vs_adp: -3 };
  expect(buildLocalDraftComparison([first, second]).reasons.some(reason => reason.label === 'ECR vs. ADP')).toBe(false);
});
