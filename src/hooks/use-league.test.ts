import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ROSTER_SETTINGS } from '@/lib/roster';
import type { LeagueInfo, LeagueMembership } from '@/lib/league';

const mocks = vi.hoisted(() => ({
  authStore: { record: { id: 'user-1' } as { id: string } | null },
  useAuction: vi.fn(),
  useLeagueContext: vi.fn(),
}));

vi.mock('@/contexts/auction-context', () => ({ useAuction: mocks.useAuction }));
vi.mock('@/contexts/league-context', () => ({ useLeagueContext: mocks.useLeagueContext }));
vi.mock('@/lib/pb-client', () => ({
  pb: { authStore: mocks.authStore },
}));

const {
  useCommissionedLeagues,
  useDraftRole,
  useDraftFormat,
  useIsCommissioner,
  useIsCommissionerOf,
  useLeague,
  useUserTeamId,
} = await import('./use-league');

const leagueA: LeagueInfo = {
  id: 'league-a',
  name: 'League A',
  commissioner: 'user-1',
  settings: DEFAULT_ROSTER_SETTINGS,
};
const leagueB: LeagueInfo = {
  id: 'league-b',
  name: 'League B',
  commissioner: 'user-1',
  settings: { ...DEFAULT_ROSTER_SETTINGS, benchSize: 5 },
};
const membershipB: LeagueMembership = {
  id: 'membership-b',
  leagueId: 'league-b',
  userId: 'user-1',
  fantasyTeamId: 'team-b',
  teamName: 'Team B',
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authStore.record = { id: 'user-1' };
  mocks.useAuction.mockReturnValue({ selectedAuction: null });
  mocks.useLeagueContext.mockReturnValue({
    memberships: [membershipB],
    leagues: [leagueA, leagueB],
    selectedLeagueId: leagueB.id,
    selectedLeague: leagueB,
    selectedMembership: membershipB,
    settings: leagueB.settings,
    format: leagueB.settings.draftFormat,
    isCommissioner: true,
    isLoading: false,
  });
});

describe('league hooks', () => {
  it('resolves settings, team, and commissioner from selected league without an auction', () => {
    expect(useLeague()).toEqual({
      league: leagueB,
      settings: leagueB.settings,
      isCommissioner: true,
    });
    expect(useUserTeamId()).toBe('team-b');
    expect(useIsCommissioner()).toBe(true);
    expect(mocks.useAuction).not.toHaveBeenCalled();
  });

  it('reads the selected league draft format without inferring it from paid slots', () => {
    expect(useDraftFormat()).toBe('hybrid');

    mocks.useLeagueContext.mockReturnValue({
      ...mocks.useLeagueContext(),
      settings: { ...DEFAULT_ROSTER_SETTINGS, paidAuctionSlots: 0 },
      format: 'auction',
    });
    expect(useDraftFormat()).toBe('auction');

    mocks.useLeagueContext.mockReturnValue({
      ...mocks.useLeagueContext(),
      format: 'snake',
    });
    expect(useDraftFormat()).toBe('snake');
    expect(mocks.useAuction).not.toHaveBeenCalled();
  });

  it('returns every commissioned league and checks a specific league', () => {
    expect(useCommissionedLeagues()).toEqual([leagueA, leagueB]);
    expect(useIsCommissionerOf('league-a')).toBe(true);
    expect(useIsCommissionerOf('missing')).toBe(false);
  });

  it('keeps auction ownership as the other pick-entry lane', () => {
    mocks.useLeagueContext.mockReturnValue({
      ...mocks.useLeagueContext(),
      isCommissioner: false,
    });
    mocks.useAuction.mockReturnValue({ selectedAuction: { user: 'user-1' } });

    expect(useDraftRole()).toEqual({
      canPickAnyTeam: true,
      userTeamId: 'team-b',
    });
  });
});
