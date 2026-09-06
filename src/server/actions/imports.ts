'use server';

import { requireAuth } from '@/server/lib/pocketbase';
import { mapLeagueRecord } from '@/lib/league';
import { isScoringFormat } from '@/lib/fantasy-scoring';
import {
  importRankingsCore,
  importRookiesCore,
  importAuctionValuesCore,
  calculateProjectedValuesCore,
} from '@/server/lib/import-core';
import { syncPlayerIdsCore } from '@/server/lib/player-ids';
import {
  ImportInput,
  RankingImportInput,
  ImportReport,
  CalculateProjectedResult,
  CalculateProjectedValuesInput,
  PlayerIdSyncReport,
} from '@/server/types/import';

async function requireSelectedLeagueCommissioner(
  action: string,
  input: { leagueId: string; scoringFormat: unknown }
) {
  const { pb, userId } = await requireAuth();
  if (!isScoringFormat(input.scoringFormat)) {
    throw new Error('Invalid scoring format');
  }

  const league = await pb.collection('leagues').getOne(input.leagueId);
  if (league.commissioner !== userId) {
    throw new Error(`Only the selected league commissioner can ${action}`);
  }

  const leagueFormat = mapLeagueRecord(league).settings.scoringFormat;
  if (leagueFormat !== input.scoringFormat) {
    throw new Error(`Selected league uses ${leagueFormat}, not ${input.scoringFormat}`);
  }

  return pb;
}

export async function importRankings(input: RankingImportInput): Promise<ImportReport> {
  try {
    const pb = await requireSelectedLeagueCommissioner('import rankings', input);
    return await importRankingsCore(pb, input);
  } catch (error) {
    console.error('Error importing rankings:', error);
    throw error instanceof Error ? error : new Error('Failed to import rankings');
  }
}

export async function importRookies(input: ImportInput): Promise<ImportReport> {
  try {
    const { pb } = await requireAuth();
    return await importRookiesCore(pb, input);
  } catch (error) {
    console.error('Error importing rookies:', error);
    throw new Error('Failed to import rookies');
  }
}

export async function importAuctionValues(input: ImportInput): Promise<ImportReport> {
  try {
    const { pb } = await requireAuth();
    return await importAuctionValuesCore(pb, input);
  } catch (error) {
    console.error('Error importing auction values:', error);
    throw new Error('Failed to import auction values');
  }
}

// `players` and `player_seasons` are single league-wide tables. PocketBase's
// own write rules on both are `@collection.leagues.commissioner ?= @request.auth.id`
// — i.e. "is a commissioner of *some* league", which is as specific as a
// collection rule can get. This narrows that to the commissioner of the
// caller's own league, and turns a bare PB 403 into a readable message.
async function requireCommissioner(action: string) {
  const { pb, userId } = await requireAuth();

  const memberships = await pb.collection('league_members').getList(1, 1, {
    filter: pb.filter('user = {:userId}', { userId }),
  });
  const leagueId: string | null = memberships.items[0]?.league ?? null;
  if (!leagueId) throw new Error(`${action} requires a league`);

  const league = await pb.collection('leagues').getOne(leagueId);
  if (league.commissioner !== userId) {
    throw new Error(`Only the league commissioner can ${action.toLowerCase()}`);
  }

  return pb;
}

export async function calculateProjectedValues(
  input: CalculateProjectedValuesInput
): Promise<CalculateProjectedResult> {
  try {
    const pb = await requireSelectedLeagueCommissioner(
      'recalculate projected values',
      input
    );
    return await calculateProjectedValuesCore(pb, input.year, input.leagueId);
  } catch (error) {
    console.error('Error calculating projected values:', error);
    throw error instanceof Error
      ? error
      : new Error('Failed to calculate projected values');
  }
}

// Fills players.sleeper_id / espn_id / fantasypros_id for players that lack
// them — the step a rankings import leaves undone, without which new players
// have no headshot, no injury badge, and a dead compare panel.
export async function syncPlayerIds(
  options: { force?: boolean } = {}
): Promise<PlayerIdSyncReport> {
  try {
    const pb = await requireCommissioner('Sync player IDs');
    return await syncPlayerIdsCore(pb, options);
  } catch (error) {
    console.error('Error syncing player IDs:', error);
    throw error instanceof Error ? error : new Error('Failed to sync player IDs');
  }
}
