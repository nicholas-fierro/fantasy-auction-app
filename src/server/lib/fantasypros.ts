import 'server-only';

import {
  buildExpertDraftComparison,
  type ComparablePlayer,
  type DraftComparison,
  type ExpertBallot,
} from '@/lib/draft-comparison';

const FANTASYPROS_BASE_URL = 'https://api.fantasypros.com/public/v2/json/nfl';

interface RankingEntry {
  expert_id?: string | number;
  rank?: string | number;
}

interface FantasyProsCompareResponse {
  rankings?: Record<string, Record<string, RankingEntry[]>>;
  experts?: Record<string, { expert_display_name?: string; expert_name?: string }>;
  updated_at?: string;
  last_updated?: string;
  message?: string;
}

export class FantasyProsUnavailableError extends Error {}

export function isFantasyProsConfigured(): boolean {
  return Boolean(process.env.FANTASYPROS_API_KEY?.trim());
}

function apiKey(): string {
  const key = process.env.FANTASYPROS_API_KEY?.trim();
  if (!key) throw new FantasyProsUnavailableError('FantasyPros API key is not configured.');
  return key;
}

function comparePosition([first, second]: readonly [ComparablePlayer, ComparablePlayer]): string {
  return first.position === second.position ? first.position : 'ALL';
}

function toBallots(
  players: readonly [ComparablePlayer, ComparablePlayer],
  response: FantasyProsCompareResponse,
): ExpertBallot[] {
  const rankings = response.rankings?.HALF;
  if (!rankings) return [];

  const ballots = new Map<string, ExpertBallot>();
  for (const player of players) {
    const fantasyProsId = player.fantasypros_id;
    if (!fantasyProsId) continue;
    for (const entry of rankings[fantasyProsId] ?? []) {
      const expertId = String(entry.expert_id ?? '');
      const rank = Number(entry.rank);
      if (!expertId || !Number.isFinite(rank) || rank <= 0) continue;

      const expert = response.experts?.[expertId];
      const ballot = ballots.get(expertId) ?? {
        expertId,
        expertName: expert?.expert_display_name ?? expert?.expert_name,
        playerRanks: {},
      };
      ballot.playerRanks[player.id] = rank;
      ballots.set(expertId, ballot);
    }
  }

  return [...ballots.values()];
}

/** Fetches half-PPR expert ballots. This module is server-only so the API key never reaches the browser. */
export async function getFantasyProsDraftComparison(
  players: readonly [ComparablePlayer, ComparablePlayer],
): Promise<DraftComparison> {
  const [first, second] = players;
  if (!first.fantasypros_id || !second.fantasypros_id) {
    throw new FantasyProsUnavailableError('Both players need a FantasyPros ID mapping.');
  }

  const url = new URL(`${FANTASYPROS_BASE_URL}/compare-players`);
  url.searchParams.set('players', `${first.fantasypros_id}:${second.fantasypros_id}`);
  url.searchParams.set('position', comparePosition(players));
  url.searchParams.set('ranking_type', 'draft');
  url.searchParams.set('details', 'all');

  const response = await fetch(url, {
    headers: { 'x-api-key': apiKey() },
    next: { revalidate: 60 * 30 },
  });
  const payload = await response.json().catch(() => ({})) as FantasyProsCompareResponse;
  if (!response.ok) {
    throw new Error(payload.message || `FantasyPros API request failed (${response.status}).`);
  }

  const comparison = buildExpertDraftComparison(
    players,
    toBallots(players, payload),
    payload.updated_at ?? payload.last_updated,
  );
  if (!comparison.totalExperts) {
    throw new FantasyProsUnavailableError('FantasyPros returned no comparable half-PPR expert ballots.');
  }
  return comparison;
}
