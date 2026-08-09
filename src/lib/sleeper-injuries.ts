export type InjurySeverity = 'critical' | 'warning' | 'caution';

export interface PlayerInjury {
  sleeperId: string;
  status: string;
  shortStatus: string;
  bodyPart: string | null;
  startDate: string | null;
  practiceParticipation: string | null;
  updatedAt: string | null;
  severity: InjurySeverity;
}

export interface PlayerInjuriesResponse {
  injuries: Record<string, PlayerInjury>;
  fetchedAt: string;
}

export interface SleeperPlayerRecord {
  player_id?: string | number | null;
  injury_status?: string | null;
  injury_body_part?: string | null;
  injury_start_date?: string | null;
  practice_participation?: string | null;
  status?: string | null;
  news_updated?: string | number | null;
}

interface Designation {
  status: string;
  shortStatus: string;
  severity: InjurySeverity;
}

const DESIGNATIONS: Record<string, Designation> = {
  ir: { status: 'Injured Reserve', shortStatus: 'IR', severity: 'critical' },
  'injured reserve': { status: 'Injured Reserve', shortStatus: 'IR', severity: 'critical' },
  pup: { status: 'Physically Unable to Perform', shortStatus: 'PUP', severity: 'critical' },
  'physically unable to perform': {
    status: 'Physically Unable to Perform',
    shortStatus: 'PUP',
    severity: 'critical',
  },
  nfi: { status: 'Non-Football Injury', shortStatus: 'NFI', severity: 'critical' },
  'non-football injury': {
    status: 'Non-Football Injury',
    shortStatus: 'NFI',
    severity: 'critical',
  },
  out: { status: 'Out', shortStatus: 'O', severity: 'critical' },
  doubtful: { status: 'Doubtful', shortStatus: 'D', severity: 'warning' },
  questionable: { status: 'Questionable', shortStatus: 'Q', severity: 'caution' },
};

function nonEmpty(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function normalizeUpdatedAt(value: SleeperPlayerRecord['news_updated']): string | null {
  if (value == null || value === '') return null;
  const milliseconds = Number(value);
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return null;
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function normalizeSleeperInjury(
  sleeperId: string,
  player: SleeperPlayerRecord
): PlayerInjury | null {
  const injuryStatus = nonEmpty(player.injury_status);
  const rosterStatus = nonEmpty(player.status);
  const designation =
    (injuryStatus ? DESIGNATIONS[injuryStatus.toLowerCase()] : undefined) ??
    (rosterStatus ? DESIGNATIONS[rosterStatus.toLowerCase()] : undefined);

  if (!designation) return null;

  return {
    sleeperId,
    ...designation,
    bodyPart: nonEmpty(player.injury_body_part),
    startDate: nonEmpty(player.injury_start_date),
    practiceParticipation: nonEmpty(player.practice_participation),
    updatedAt: normalizeUpdatedAt(player.news_updated),
  };
}

export function normalizeSleeperInjuries(
  players: Record<string, SleeperPlayerRecord>
): Record<string, PlayerInjury> {
  const injuries: Record<string, PlayerInjury> = {};

  for (const [recordId, player] of Object.entries(players)) {
    const sleeperId = String(player.player_id ?? recordId);
    const injury = normalizeSleeperInjury(sleeperId, player);
    if (injury) injuries[sleeperId] = injury;
  }

  return injuries;
}
