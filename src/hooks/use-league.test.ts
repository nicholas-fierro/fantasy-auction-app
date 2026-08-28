import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ROSTER_SETTINGS } from '@/lib/roster';

const mocks = vi.hoisted(() => ({
  authStore: { record: { id: 'user-1' } as { id: string } | null },
  collection: vi.fn(),
  filter: vi.fn(),
  getList: vi.fn(),
  useAuction: vi.fn(),
  useQuery: vi.fn(),
}));

vi.mock('@tanstack/react-query', () => ({ useQuery: mocks.useQuery }));
vi.mock('@/contexts/auction-context', () => ({ useAuction: mocks.useAuction }));
vi.mock('@/lib/pb-client', () => ({
  pb: {
    authStore: mocks.authStore,
    collection: mocks.collection,
    filter: mocks.filter,
  },
}));

const { useCommissionerLeague } = await import('./use-league');

type QueryOptions = {
  queryKey: unknown[];
  queryFn: () => Promise<unknown>;
  enabled: boolean;
};

function CommissionerLeagueProbe() {
  return useCommissionerLeague();
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authStore.record = { id: 'user-1' };
  mocks.collection.mockReturnValue({ getList: mocks.getList });
  mocks.filter.mockImplementation((expression, params) => ({ expression, params }));
  mocks.useQuery.mockReturnValue({ data: undefined });
});

describe('useCommissionerLeague', () => {
  it('resolves commissioner league without consulting selected auction', async () => {
    mocks.getList.mockResolvedValue({
      items: [{
        id: 'league-1',
        name: 'Test League',
        commissioner: 'user-1',
        settings: { benchSize: 7, scoringFormat: 'half' },
      }],
    });

    CommissionerLeagueProbe();

    expect(mocks.useAuction).not.toHaveBeenCalled();
    const options = mocks.useQuery.mock.calls[0][0] as QueryOptions;
    expect(options.queryKey).toEqual(['commissioner-league', 'user-1']);
    expect(options.enabled).toBe(true);

    await expect(options.queryFn()).resolves.toEqual({
      id: 'league-1',
      name: 'Test League',
      commissioner: 'user-1',
      settings: {
        ...DEFAULT_ROSTER_SETTINGS,
        benchSize: 7,
        scoringFormat: 'half',
      },
    });
    expect(mocks.collection).toHaveBeenCalledWith('leagues');
    expect(mocks.filter).toHaveBeenCalledWith(
      'commissioner = {:userId}',
      { userId: 'user-1' }
    );
  });

  it('returns defaults when authenticated user commissions no league', async () => {
    mocks.getList.mockResolvedValue({ items: [] });

    CommissionerLeagueProbe();

    const options = mocks.useQuery.mock.calls[0][0] as QueryOptions;
    await expect(options.queryFn()).resolves.toBeNull();

    mocks.useQuery.mockReturnValue({ data: null });
    expect(CommissionerLeagueProbe()).toEqual({
      league: null,
      settings: DEFAULT_ROSTER_SETTINGS,
    });
  });

  it('falls back from an invalid scoring format', async () => {
    mocks.getList.mockResolvedValue({
      items: [{
        id: 'league-1',
        name: 'Test League',
        commissioner: 'user-1',
        settings: { scoringFormat: 'invalid' },
      }],
    });

    CommissionerLeagueProbe();

    const options = mocks.useQuery.mock.calls[0][0] as QueryOptions;
    await expect(options.queryFn()).resolves.toMatchObject({
      settings: { scoringFormat: DEFAULT_ROSTER_SETTINGS.scoringFormat },
    });
  });

  it('does not query without an authenticated user', () => {
    mocks.authStore.record = null;

    CommissionerLeagueProbe();

    const options = mocks.useQuery.mock.calls[0][0] as QueryOptions;
    expect(options.queryKey).toEqual(['commissioner-league', null]);
    expect(options.enabled).toBe(false);
  });
});
