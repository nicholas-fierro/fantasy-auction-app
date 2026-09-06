'use server';

import { randomBytes } from 'node:crypto';
import { ClientResponseError, RecordModel } from 'pocketbase';
import { requireAuth } from '@/server/lib/pocketbase';
import { assertAuctionOwned } from '@/server/lib/auction-guard';
import { Auction, CreateAuctionInput, ReplaceAuctionResolution } from '@/server/types/auction';

const ACTIVE_AUCTION_ERRORS = {
  official: 'Complete or delete the active official draft before starting a new auction',
  mock: 'Complete or delete the active mock draft before starting a new auction',
} as const;

class AuctionValidationError extends Error {}

function mapAuctionRecord(record: RecordModel): Auction {
  return {
    id: record.id,
    name: record.name,
    year: record.year || null,
    type: record.type,
    sim: record.sim ?? false,
    status: record.status,
    user: record.user,
    league: record.league || null,
    // Never set by this action — auctions created through the app always belong
    // to a user and a league. Only the CLI importer writes external boards.
    external: record.external === true,
    drafted_at: record.drafted_at || record.created,
    created: record.created,
    updated: record.updated,
  };
}

function assertAuctionInput(input: CreateAuctionInput) {
  if (input.type !== 'official' && input.type !== 'mock') {
    throw new Error('Invalid auction type');
  }
}

async function resolveLeagueId(
  pb: Awaited<ReturnType<typeof requireAuth>>['pb'],
  userId: string,
  input: CreateAuctionInput
): Promise<string> {
  if (!input.leagueId) {
    throw new AuctionValidationError('Select a league before starting a draft');
  }

  const memberships = await pb.collection('league_members').getList(1, 1, {
    filter: pb.filter('user = {:userId} && league = {:leagueId}', {
      userId,
      leagueId: input.leagueId,
    }),
  });
  if (memberships.items.length === 0) {
    throw new AuctionValidationError('You must be a member of the selected league');
  }

  if (input.type === 'official') {
    const league = await pb.collection('leagues').getOne(input.leagueId);
    if (league.commissioner !== userId) {
      throw new AuctionValidationError(
        'Only the selected league commissioner can start an official auction',
      );
    }
  }

  const teamIds = input.teamOrder.map(entry => entry.fantasy_team_id);
  if (teamIds.length === 0 || new Set(teamIds).size !== teamIds.length) {
    throw new AuctionValidationError('Select a non-empty draft order without duplicate teams');
  }
  const leagueTeams = await pb.collection('fantasy_teams').getFullList({
    filter: pb.filter('league = {:leagueId}', { leagueId: input.leagueId }),
    fields: 'id',
  });
  const allowedTeamIds = new Set(leagueTeams.map(team => team.id));
  if (teamIds.some(id => !allowedTeamIds.has(id))) {
    throw new AuctionValidationError('Every draft team must belong to the selected league');
  }

  return input.leagueId;
}

function auctionData(input: CreateAuctionInput, userId: string, leagueId: string | null, id?: string) {
  return {
    ...(id ? { id } : {}),
    name: input.name,
    year: input.year,
    type: input.type,
    sim: input.type === 'mock' ? input.sim ?? false : false,
    status: 'active',
    user: userId,
    league: leagueId,
    drafted_at: new Date().toISOString(),
  };
}

// PocketBase reports a unique-index violation as a per-field
// `validation_not_unique` code, but nests it differently depending on the write:
// `data.<field>.code` for a single record, `data.requests.<n>.response.data.
// <field>.code` inside a batch transaction. Scan for the code rather than
// hard-coding either shape — the batch form is what the create-during-replace
// race actually produces.
function hasUniqueViolation(error: unknown): boolean {
  if (!(error instanceof ClientResponseError)) return false;
  const containsCode = (value: unknown): boolean => {
    if (!value || typeof value !== 'object') return false;
    if ((value as { code?: unknown }).code === 'validation_not_unique') return true;
    return Object.values(value).some(containsCode);
  };
  return containsCode(error.response?.data);
}

function isActiveAuctionConflict(error: unknown): boolean {
  return error instanceof Error && (
    error.message === ACTIVE_AUCTION_ERRORS.official ||
    error.message === ACTIVE_AUCTION_ERRORS.mock
  );
}

function activeAuctionConflict(type: CreateAuctionInput['type']): Error {
  return new Error(ACTIVE_AUCTION_ERRORS[type]);
}

export async function createAuction(input: CreateAuctionInput): Promise<Auction> {
  try {
    const { pb, userId } = await requireAuth();
    assertAuctionInput(input);
    const leagueId = await resolveLeagueId(pb, userId, input);

    const activeRecords = await pb.collection('auctions').getFullList({
      filter: pb.filter('status = "active" && user = {:userId} && type = {:type} && league = {:leagueId}', {
        userId,
        type: input.type,
        leagueId,
      }),
    });
    if (activeRecords.length) throw activeAuctionConflict(input.type);

    const record = await pb.collection('auctions').create(auctionData(input, userId, leagueId));

    // requestKey: null disables the SDK's auto-cancellation, which would
    // otherwise abort all but the last of these concurrent identical creates
    await Promise.all(
      input.teamOrder.map(entry =>
        pb.collection('auction_teams').create({
          auction_id: record.id,
          fantasy_team_id: entry.fantasy_team_id,
          draft_order: entry.draft_order,
        }, { requestKey: null })
      )
    );

    return mapAuctionRecord(record);
  } catch (error) {
    console.error('Error creating auction:', error);
    if (isActiveAuctionConflict(error) || hasUniqueViolation(error)) {
      throw activeAuctionConflict(input.type);
    }
    if (error instanceof AuctionValidationError) throw error;
    throw new Error('Failed to create auction');
  }
}

export async function replaceAuction(
  activeId: string,
  input: CreateAuctionInput,
  resolution: ReplaceAuctionResolution
): Promise<Auction> {
  try {
    const { pb, userId } = await requireAuth();
    assertAuctionInput(input);
    if (resolution !== 'complete' && resolution !== 'delete') {
      throw new Error('Invalid replacement resolution');
    }

    const activeAuction = await assertAuctionOwned(pb, userId, activeId);
    if (activeAuction.status !== 'active') {
      throw new Error('Only active auctions can be replaced');
    }
    if (activeAuction.type !== input.type) {
      throw new Error('Replacement auction type must match the active auction type');
    }
    if (activeAuction.league !== input.leagueId) {
      throw new AuctionValidationError('Replacement auction must stay in the same league');
    }

    const leagueId = await resolveLeagueId(pb, userId, input);
    const newAuctionId = randomBytes(8).toString('hex').slice(0, 15);
    const batch = pb.createBatch();

    if (resolution === 'delete') {
      const picks = await pb.collection('draft_picks').getFullList({
        filter: pb.filter('auction_id = {:id}', { id: activeId }),
      });
      // Pick deletes must run while the auction is active to satisfy PB rules,
      // so they are queued before the auction itself goes away. The batch is one
      // transaction, so another writer cannot interleave here.
      for (const pick of picks) batch.collection('draft_picks').delete(pick.id);
      batch.collection('auctions').delete(activeId);
    } else {
      batch.collection('auctions').update(activeId, { status: 'completed' });
    }

    batch.collection('auctions').create(auctionData(input, userId, leagueId, newAuctionId));
    for (const entry of input.teamOrder) {
      batch.collection('auction_teams').create({
        auction_id: newAuctionId,
        fantasy_team_id: entry.fantasy_team_id,
        draft_order: entry.draft_order,
      });
    }

    const results = await batch.send();
    const created = results.find(result => (result.body as RecordModel | undefined)?.id === newAuctionId);
    if (!created) throw new Error('Replacement auction was not created');
    return mapAuctionRecord(created.body as RecordModel);
  } catch (error) {
    console.error('Error replacing auction:', error);
    if (hasUniqueViolation(error)) throw activeAuctionConflict(input.type);
    if (error instanceof AuctionValidationError) throw error;
    throw new Error('Failed to replace auction');
  }
}

export async function completeAuction(id: string): Promise<Auction> {
  try {
    const { pb, userId } = await requireAuth();
    await assertAuctionOwned(pb, userId, id);

    const record = await pb.collection('auctions').update(id, { status: 'completed' });
    return mapAuctionRecord(record);
  } catch (error) {
    console.error('Error completing auction:', error);
    throw new Error('Failed to complete auction');
  }
}

// Permanently deletes an auction; draft_picks and auction_teams rows cascade.
// Deleting the picks by hand instead would hit their delete rule, which requires
// an active auction — so a completed draft with picks could never be removed.
// No other draft is promoted; any opposite-type active draft remains available,
// and completed drafts remain read-only history.
export async function deleteAuction(id: string): Promise<void> {
  try {
    const { pb, userId } = await requireAuth();
    const auction = await assertAuctionOwned(pb, userId, id);

    if (auction.status !== 'active' && auction.status !== 'completed') {
      throw new Error(`Cannot delete auction with status ${auction.status}`);
    }

    await pb.collection('auctions').delete(id);
  } catch (error) {
    console.error('Error deleting auction:', error);
    if (error instanceof ClientResponseError) {
      throw new Error(`Failed to delete auction: ${error.message} (${error.status})`);
    }
    throw new Error(`Failed to delete auction: ${error instanceof Error ? error.message : String(error)}`);
  }
}
