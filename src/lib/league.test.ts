import { describe, expect, it } from 'vitest';
import type { RecordModel } from 'pocketbase';
import { DEFAULT_ROSTER_SETTINGS } from '@/lib/roster';
import {
  mapLeagueRecord,
  resolveSelectedLeagueId,
  type LeagueMembership,
} from '@/lib/league';

function membership(leagueId: string): LeagueMembership {
  return {
    id: `membership-${leagueId}`,
    leagueId,
    userId: 'user-1',
    fantasyTeamId: `team-${leagueId}`,
    teamName: `Team ${leagueId}`,
  };
}

describe('mapLeagueRecord', () => {
  it('merges partial settings over defaults', () => {
    const league = mapLeagueRecord({
      id: 'league-1',
      name: 'League',
      commissioner: 'user-1',
      settings: { benchSize: 5, scoringFormat: 'ppr' },
    } as unknown as RecordModel);

    expect(league.settings).toEqual({
      ...DEFAULT_ROSTER_SETTINGS,
      benchSize: 5,
      scoringFormat: 'ppr',
    });
  });

  it('falls back from unknown scoring and draft formats', () => {
    const league = mapLeagueRecord({
      id: 'league-1',
      name: 'League',
      commissioner: 'user-1',
      settings: { scoringFormat: 'unknown', draftFormat: 'unknown' },
    } as unknown as RecordModel);

    expect(league.settings.scoringFormat).toBe(DEFAULT_ROSTER_SETTINGS.scoringFormat);
    expect(league.settings.draftFormat).toBe(DEFAULT_ROSTER_SETTINGS.draftFormat);
  });
});

describe('resolveSelectedLeagueId', () => {
  it('silently selects the only membership', () => {
    expect(resolveSelectedLeagueId([membership('league-a')], null)).toBe('league-a');
  });

  it('keeps a valid persisted selection for multiple memberships', () => {
    expect(resolveSelectedLeagueId(
      [membership('league-a'), membership('league-b')],
      'league-b',
    )).toBe('league-b');
  });

  it('requires an explicit choice when multiple memberships have no valid selection', () => {
    const memberships = [membership('league-a'), membership('league-b')];
    expect(resolveSelectedLeagueId(memberships, null)).toBeNull();
    expect(resolveSelectedLeagueId(memberships, 'missing')).toBeNull();
  });
});
