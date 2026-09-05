import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CalculateProjectedValuesInput,
  RankingImportInput,
  RankingScoringFormat,
} from '@/server/types/import';

const auth = vi.hoisted(() => ({ requireAuth: vi.fn() }));
const core = vi.hoisted(() => ({
  importRankingsCore: vi.fn(),
  importRookiesCore: vi.fn(),
  importAuctionValuesCore: vi.fn(),
  calculateProjectedValuesCore: vi.fn(),
}));

vi.mock('@/server/lib/pocketbase', () => ({ requireAuth: auth.requireAuth }));
vi.mock('@/server/lib/import-core', () => core);

const { calculateProjectedValues, importRankings } = await import('./imports');

const report = {
  created: 0,
  updated: 1,
  skipped: 0,
  unmatched: [],
  ambiguous: [],
  fuzzy: [],
};

function input(scoringFormat: RankingScoringFormat = 'ppr'): RankingImportInput {
  return {
    year: 2026,
    csvText: 'RK,PLAYER NAME\n1,Player',
    leagueId: 'league-1',
    scoringFormat,
  };
}

function fakePocketBase(
  commissioner = 'user-1',
  scoringFormat: RankingScoringFormat = 'ppr'
) {
  const leagues = {
    getOne: vi.fn(async () => ({
      id: 'league-1',
      name: 'League',
      commissioner,
      settings: { scoringFormat },
    })),
  };
  return {
    pb: {
      collection: vi.fn((name: string) => {
        if (name !== 'leagues') throw new Error(`Unexpected collection ${name}`);
        return leagues;
      }),
    },
    leagues,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  core.importRankingsCore.mockResolvedValue(report);
  core.calculateProjectedValuesCore.mockResolvedValue({
    updated: 1,
    unchanged: 0,
    historyYears: [2025],
    top: [],
  });
});

describe('importRankings', () => {
  it('imports into the selected league matching board', async () => {
    const fake = fakePocketBase();
    auth.requireAuth.mockResolvedValue({ pb: fake.pb, userId: 'user-1' });
    const request = input();

    await expect(importRankings(request)).resolves.toEqual(report);
    expect(fake.leagues.getOne).toHaveBeenCalledWith('league-1');
    expect(core.importRankingsCore).toHaveBeenCalledWith(fake.pb, request);
  });

  it('lets a standard league write the legacy ranking columns', async () => {
    const fake = fakePocketBase('user-1', 'std');
    auth.requireAuth.mockResolvedValue({ pb: fake.pb, userId: 'user-1' });
    const request = input('std');

    await expect(importRankings(request)).resolves.toEqual(report);
    expect(core.importRankingsCore).toHaveBeenCalledWith(fake.pb, request);
  });

  it('rejects a board that does not match the selected league format', async () => {
    const fake = fakePocketBase('user-1', 'half');
    auth.requireAuth.mockResolvedValue({ pb: fake.pb, userId: 'user-1' });

    await expect(importRankings(input('ppr'))).rejects.toThrow(
      'Selected league uses half, not ppr'
    );
    expect(core.importRankingsCore).not.toHaveBeenCalled();
  });

  it('rejects a commissioner from another league', async () => {
    const fake = fakePocketBase('other-user');
    auth.requireAuth.mockResolvedValue({ pb: fake.pb, userId: 'user-1' });

    await expect(importRankings(input())).rejects.toThrow(
      'Only the selected league commissioner can import rankings'
    );
    expect(core.importRankingsCore).not.toHaveBeenCalled();
  });
});

describe('calculateProjectedValues', () => {
  it('prices from the selected league scoring format', async () => {
    const fake = fakePocketBase('user-1', 'ppr');
    auth.requireAuth.mockResolvedValue({ pb: fake.pb, userId: 'user-1' });
    const request: CalculateProjectedValuesInput = {
      year: 2026,
      leagueId: 'league-1',
      scoringFormat: 'ppr',
    };

    await calculateProjectedValues(request);

    expect(core.calculateProjectedValuesCore).toHaveBeenCalledWith(fake.pb, 2026, 'ppr');
  });
});
