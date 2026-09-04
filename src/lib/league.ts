import type { RecordModel } from 'pocketbase';
import { isScoringFormat } from '@/lib/fantasy-scoring';
import {
  DEFAULT_ROSTER_SETTINGS,
  isDraftFormat,
  type RosterSettings,
} from '@/lib/roster';

export interface LeagueInfo {
  id: string;
  name: string;
  commissioner: string;
  settings: RosterSettings;
}

export interface LeagueMembership {
  id: string;
  leagueId: string;
  userId: string;
  fantasyTeamId: string | null;
  teamName: string | null;
}

export function mapLeagueRecord(record: RecordModel): LeagueInfo {
  const settings: RosterSettings = {
    ...DEFAULT_ROSTER_SETTINGS,
    ...(record.settings ?? {}),
  };

  return {
    id: record.id,
    name: record.name,
    commissioner: record.commissioner,
    settings: {
      ...settings,
      scoringFormat: isScoringFormat(settings.scoringFormat)
        ? settings.scoringFormat
        : DEFAULT_ROSTER_SETTINGS.scoringFormat,
      draftFormat: isDraftFormat(settings.draftFormat)
        ? settings.draftFormat
        : DEFAULT_ROSTER_SETTINGS.draftFormat,
    },
  };
}

export function resolveSelectedLeagueId(
  memberships: readonly LeagueMembership[],
  selectedLeagueId: string | null,
): string | null {
  if (memberships.length === 1) return memberships[0].leagueId;
  if (selectedLeagueId && memberships.some(membership => membership.leagueId === selectedLeagueId)) {
    return selectedLeagueId;
  }
  return null;
}
