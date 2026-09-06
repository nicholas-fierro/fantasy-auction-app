import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  leagueId: 'league-a' as string | null,
  useQuery: vi.fn(),
  ensureQueryData: vi.fn(),
  getFullList: vi.fn(),
  filter: vi.fn((_expression: string, params: unknown) => params),
  computeHistoricalValues: vi.fn(),
  loadTeamProfiles: vi.fn(),
}));
vi.mock('@tanstack/react-query', () => ({
  useQuery: mocks.useQuery,
  useQueryClient: () => ({ ensureQueryData: mocks.ensureQueryData }),
}));
vi.mock('@/contexts/league-context', () => ({
  useLeagueContext: () => ({ selectedLeagueId: mocks.leagueId }),
}));
vi.mock('@/contexts/auction-context', () => ({ useAuction: () => ({ selectedAuctionId: null }) }));
vi.mock('@/lib/pb-client', () => ({ pb: {
  collection: () => ({ getFullList: mocks.getFullList }), filter: mocks.filter,
} }));
vi.mock('@/lib/history-client', () => ({ computeHistoricalValues: mocks.computeHistoricalValues }));
vi.mock('@/lib/team-profiles-client', () => ({ loadTeamProfiles: mocks.loadTeamProfiles }));

const { useAllFantasyTeams } = await import('./use-fantasy-teams');
const { useHistoricalValues } = await import('./use-history');
const { useTeamProfiles } = await import('./use-team-profiles');

beforeEach(() => {
  vi.clearAllMocks();
  mocks.leagueId = 'league-a';
  mocks.useQuery.mockImplementation(options => options);
  mocks.getFullList.mockResolvedValue([]);
  mocks.computeHistoricalValues.mockResolvedValue([]);
  mocks.ensureQueryData.mockImplementation(options => options.queryFn());
  mocks.loadTeamProfiles.mockResolvedValue(new Map());
});

describe('league-scoped query keys', () => {
  it.each([
    { hook: useAllFantasyTeams, key: 'fantasy-teams' },
    { hook: useHistoricalValues, key: 'historical-values' },
    { hook: useTeamProfiles, key: 'computed-profiles' },
  ])('$key changes identity when switching leagues and waits for a selection', ({ hook, key }) => {
    hook();
    expect(mocks.useQuery.mock.lastCall?.[0]).toMatchObject({ queryKey: [key, 'league-a'], enabled: true });
    mocks.leagueId = 'league-b';
    hook();
    expect(mocks.useQuery.mock.lastCall?.[0]).toMatchObject({ queryKey: [key, 'league-b'], enabled: true });
    mocks.leagueId = null;
    hook();
    expect(mocks.useQuery.mock.lastCall?.[0]).toMatchObject({ queryKey: [key, null], enabled: false });
  });

  it('captures the selected league in the team query, even after switching', async () => {
    useAllFantasyTeams();
    const { queryFn } = mocks.useQuery.mock.lastCall![0];
    mocks.leagueId = 'league-b';
    await queryFn();
    expect(mocks.filter).toHaveBeenCalledWith('league = {:leagueId}', { leagueId: 'league-a' });
    expect(mocks.getFullList).toHaveBeenCalledWith(expect.objectContaining({ filter: { leagueId: 'league-a' } }));
  });

  it('shares only the selected league history with its computed profiles', async () => {
    useTeamProfiles();
    await mocks.useQuery.mock.lastCall![0].queryFn();
    expect(mocks.ensureQueryData).toHaveBeenCalledWith(expect.objectContaining({ queryKey: ['historical-values', 'league-a'] }));
    expect(mocks.computeHistoricalValues).toHaveBeenCalledWith('league-a');
    expect(mocks.loadTeamProfiles).toHaveBeenCalledWith(expect.anything(), 'league-a', []);
  });
});
