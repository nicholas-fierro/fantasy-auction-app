import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClientResponseError } from 'pocketbase';
import type { CreateAuctionInput } from '@/server/types/auction';

const auth = vi.hoisted(() => ({ requireAuth: vi.fn() }));
const auctionGuard = vi.hoisted(() => ({ assertAuctionOwned: vi.fn() }));

vi.mock('@/server/lib/pocketbase', () => ({ requireAuth: auth.requireAuth }));
vi.mock('@/server/lib/auction-guard', () => ({ assertAuctionOwned: auctionGuard.assertAuctionOwned }));

const { createAuction, replaceAuction } = await import('./auctions');

type AuctionType = CreateAuctionInput['type'];
type ActiveAuction = { id: string; type: AuctionType; league?: string };
type BatchRequest = { collection: string; method: string; args: unknown[] };

function input(type: AuctionType): CreateAuctionInput {
  return {
    name: `${type} draft`,
    year: 2026,
    type,
    leagueId: 'league-1',
    teamOrder: [{ fantasy_team_id: 'team-1', draft_order: 1 }],
  };
}

function createPocketBase(
  activeAuctions: ActiveAuction[],
  picks: { id: string }[] = [],
  membershipLeague: string | null = 'league-1',
  commissioner = 'user-1',
) {
  const auctionRecord = {
    id: 'new-auction',
    name: 'draft',
    year: 2026,
    type: 'mock',
    sim: false,
    status: 'active',
    user: 'user-1',
    league: 'league-1',
    drafted_at: '2026-01-01T00:00:00.000Z',
    created: '2026-01-01T00:00:00.000Z',
    updated: '2026-01-01T00:00:00.000Z',
  };
  const batchRequests: BatchRequest[] = [];
  const batch = {
    collection: vi.fn((collection: string) => ({
      create: vi.fn((...args: unknown[]) => batchRequests.push({ collection, method: 'create', args })),
      update: vi.fn((...args: unknown[]) => batchRequests.push({ collection, method: 'update', args })),
      delete: vi.fn((...args: unknown[]) => batchRequests.push({ collection, method: 'delete', args })),
    })),
    send: vi.fn(async () => batchRequests.map(request => ({
      status: 200,
      body: request.collection === 'auctions' && request.method === 'create'
        ? { ...auctionRecord, ...(request.args[0] as Record<string, unknown>) }
        : {},
    }))),
  };
  const auctions = {
    getFullList: vi.fn(async ({ filter }: { filter: { type: AuctionType; leagueId: string } }) =>
      activeAuctions.filter(auction => auction.type === filter.type && (auction.league ?? 'league-1') === filter.leagueId)
    ),
    create: vi.fn(async (data: Record<string, unknown>) => ({ ...auctionRecord, ...data })),
    update: vi.fn(),
  };
  const auctionTeams = { create: vi.fn() };
  const collections = {
    league_members: {
      getList: vi.fn(async (
        _page: number,
        _perPage: number,
        options: { filter: Record<string, string> },
      ) => ({
        items: membershipLeague && options.filter.leagueId === membershipLeague
          ? [{ league: membershipLeague }]
          : [],
      })),
    },
    leagues: { getOne: vi.fn(async () => ({ commissioner })) },
    fantasy_teams: { getFullList: vi.fn(async () => [{ id: 'team-1' }]) },
    auctions,
    auction_teams: auctionTeams,
    draft_picks: { getFullList: vi.fn(async () => picks) },
  };
  const pb = {
    filter: vi.fn((_: string, params: Record<string, string>) => params),
    collection: vi.fn((name: keyof typeof collections) => collections[name]),
    createBatch: vi.fn(() => batch),
  };

  return { pb, auctions, auctionTeams, batch, batchRequests };
}

// PocketBase nests the field error one level deep on a single-record write and
// three levels deep inside a failed batch transaction — the conflict mapping has
// to survive both.
function uniqueConstraintError(shape: 'record' | 'batch' = 'record') {
  const error = new ClientResponseError();
  const fieldError = { type: { code: 'validation_not_unique' } };
  error.response = shape === 'record'
    ? { data: fieldError }
    : { data: { requests: { '1': { code: 'batch_request_failed', response: { data: fieldError } } } } };
  return error;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  auctionGuard.assertAuctionOwned.mockResolvedValue({
    id: 'active-auction',
    type: 'mock',
    status: 'active',
    user: 'user-1',
    league: 'league-1',
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createAuction active draft lifecycle', () => {
  it.each(['mock', 'official'] as const)('allows an active %s in a different league', async type => {
    const fake = createPocketBase([{ id: 'other-draft', type, league: 'league-2' }]);
    auth.requireAuth.mockResolvedValue({ pb: fake.pb, userId: 'user-1' });
    await expect(createAuction(input(type))).resolves.toMatchObject({ league: 'league-1' });
    expect(fake.auctions.update).not.toHaveBeenCalled();
  });

  it('requires an explicit league rather than selecting a membership', async () => {
    const fake = createPocketBase([]);
    auth.requireAuth.mockResolvedValue({ pb: fake.pb, userId: 'user-1' });
    await expect(createAuction({ ...input('mock'), leagueId: '' })).rejects.toThrow('Select a league');
    expect(fake.auctions.create).not.toHaveBeenCalled();
  });

  it.each(['mock', 'official'] as const)('rejects foreign teams before creating a %s draft', async type => {
    const fake = createPocketBase([]);
    auth.requireAuth.mockResolvedValue({ pb: fake.pb, userId: 'user-1' });
    const foreignTeam = { ...input(type), teamOrder: [{ fantasy_team_id: 'foreign-team', draft_order: 1 }] };
    await expect(createAuction(foreignTeam)).rejects.toThrow('Every draft team must belong to the selected league');
    expect(fake.pb.filter).toHaveBeenCalledWith('league = {:leagueId}', { leagueId: 'league-1' });
    expect(fake.auctions.create).not.toHaveBeenCalled();
    expect(fake.auctionTeams.create).not.toHaveBeenCalled();
  });

  it.each([{ teamOrder: [] }, { teamOrder: [input('mock').teamOrder[0], input('mock').teamOrder[0]] }])('rejects empty or duplicate teams', async ({ teamOrder }) => {
    const fake = createPocketBase([]);
    auth.requireAuth.mockResolvedValue({ pb: fake.pb, userId: 'user-1' });
    await expect(createAuction({ ...input('mock'), teamOrder })).rejects.toThrow('non-empty draft order without duplicate teams');
    expect(fake.auctions.create).not.toHaveBeenCalled();
  });
  it.each([
    ['mock', 'official'],
    ['official', 'mock'],
  ] as const)('allows an active %s draft alongside an active %s draft', async (type, existingType) => {
    const fake = createPocketBase([{ id: 'active-auction', type: existingType }]);
    auth.requireAuth.mockResolvedValue({ pb: fake.pb, userId: 'user-1' });

    await expect(createAuction(input(type))).resolves.toMatchObject({ type, status: 'active' });

    expect(fake.pb.filter).toHaveBeenCalledWith(
      'status = "active" && user = {:userId} && type = {:type} && league = {:leagueId}',
      { userId: 'user-1', type, leagueId: 'league-1' }
    );
    expect(fake.auctions.update).not.toHaveBeenCalled();
    expect(fake.auctions.create).toHaveBeenCalledTimes(1);
    expect(fake.auctionTeams.create).toHaveBeenCalledTimes(1);
  });

  it('creates the draft in the selected league', async () => {
    const selected = { ...input('mock'), leagueId: 'league-2' };
    const fake = createPocketBase([], [], 'league-2');
    auth.requireAuth.mockResolvedValue({ pb: fake.pb, userId: 'user-1' });

    await expect(createAuction(selected)).resolves.toMatchObject({
      league: 'league-2',
      status: 'active',
    });

    expect(fake.pb.filter).toHaveBeenCalledWith(
      'user = {:userId} && league = {:leagueId}',
      { userId: 'user-1', leagueId: 'league-2' },
    );
    expect(fake.auctions.create).toHaveBeenCalledWith(
      expect.objectContaining({ league: 'league-2' }),
    );
  });

  it('rejects a draft for a league the caller has not joined', async () => {
    const fake = createPocketBase([], [], null);
    auth.requireAuth.mockResolvedValue({ pb: fake.pb, userId: 'user-1' });

    await expect(createAuction(input('mock'))).rejects.toThrow(
      'You must be a member of the selected league',
    );
    expect(fake.auctions.create).not.toHaveBeenCalled();
  });

  it('rejects an official draft for a league the caller does not commission', async () => {
    const fake = createPocketBase([], [], 'league-1', 'other-user');
    auth.requireAuth.mockResolvedValue({ pb: fake.pb, userId: 'user-1' });

    await expect(createAuction(input('official'))).rejects.toThrow(
      'Only the selected league commissioner can start an official auction',
    );
    expect(fake.auctions.create).not.toHaveBeenCalled();
  });

  it.each(['mock', 'official'] as const)('blocks a second active %s draft', async (type) => {
    const fake = createPocketBase([{ id: 'active-auction', type }]);
    auth.requireAuth.mockResolvedValue({ pb: fake.pb, userId: 'user-1' });

    await expect(createAuction(input(type))).rejects.toThrow(
      `Complete or delete the active ${type} draft before starting a new auction`
    );

    expect(fake.auctions.update).not.toHaveBeenCalled();
    expect(fake.auctions.create).not.toHaveBeenCalled();
  });

  it('maps a raced unique constraint to the active-draft conflict', async () => {
    const fake = createPocketBase([]);
    fake.auctions.create.mockRejectedValue(uniqueConstraintError());
    auth.requireAuth.mockResolvedValue({ pb: fake.pb, userId: 'user-1' });

    await expect(createAuction(input('mock'))).rejects.toThrow(
      'Complete or delete the active mock draft before starting a new auction'
    );
  });
});

describe('replaceAuction', () => {
  it('rejects foreign teams before closing the current draft', async () => {
    const fake = createPocketBase([]);
    auth.requireAuth.mockResolvedValue({ pb: fake.pb, userId: 'user-1' });
    const replacement = { ...input('mock'), teamOrder: [{ fantasy_team_id: 'foreign-team', draft_order: 1 }] };
    await expect(replaceAuction('active-auction', replacement, 'delete')).rejects.toThrow('Every draft team must belong to the selected league');
    expect(fake.pb.createBatch).not.toHaveBeenCalled();
  });
  it.each([
    [{ status: 'completed', type: 'mock' }, input('mock')],
    [{ status: 'active', type: 'official' }, input('mock')],
  ] as const)('rejects an inactive or different-type replacement before opening a batch', async (activeAuction, replacement) => {
    const fake = createPocketBase([]);
    auctionGuard.assertAuctionOwned.mockResolvedValue({ id: 'active-auction', user: 'user-1', ...activeAuction });
    auth.requireAuth.mockResolvedValue({ pb: fake.pb, userId: 'user-1' });

    await expect(replaceAuction('active-auction', replacement, 'complete')).rejects.toThrow(
      'Failed to replace auction'
    );

    expect(fake.pb.createBatch).not.toHaveBeenCalled();
  });

  it('rejects moving a replacement draft into another league', async () => {
    const fake = createPocketBase([]);
    auctionGuard.assertAuctionOwned.mockResolvedValue({
      id: 'active-auction',
      user: 'user-1',
      type: 'mock',
      status: 'active',
      league: 'league-2',
    });
    auth.requireAuth.mockResolvedValue({ pb: fake.pb, userId: 'user-1' });

    await expect(replaceAuction('active-auction', input('mock'), 'complete')).rejects.toThrow(
      'Replacement auction must stay in the same league',
    );
    expect(fake.pb.createBatch).not.toHaveBeenCalled();
  });

  it('queues completion before creating a same-type replacement and its teams', async () => {
    const fake = createPocketBase([]);
    auth.requireAuth.mockResolvedValue({ pb: fake.pb, userId: 'user-1' });

    await expect(replaceAuction('active-auction', input('mock'), 'complete')).resolves.toMatchObject({
      type: 'mock',
      status: 'active',
    });

    expect(fake.batchRequests).toHaveLength(3);
    expect(fake.batchRequests[0]).toEqual({
      collection: 'auctions',
      method: 'update',
      args: ['active-auction', { status: 'completed' }],
    });
    expect(fake.batchRequests[1]).toMatchObject({ collection: 'auctions', method: 'create' });
    expect((fake.batchRequests[1].args[0] as { id: string }).id).toMatch(/^[a-z0-9]{15}$/);
    expect(fake.batchRequests[2]).toMatchObject({ collection: 'auction_teams', method: 'create' });
    expect(fake.batch.send).toHaveBeenCalledOnce();
  });

  it('deletes picks while active before closing and replacing the old auction', async () => {
    const fake = createPocketBase([], [{ id: 'pick-1' }, { id: 'pick-2' }]);
    auth.requireAuth.mockResolvedValue({ pb: fake.pb, userId: 'user-1' });

    // The created auction is located by id, not by position, so pick deletes
    // shifting the batch cannot make it return the wrong record.
    await expect(replaceAuction('active-auction', input('mock'), 'delete')).resolves.toMatchObject({
      type: 'mock',
      status: 'active',
    });

    expect(fake.batchRequests.map(({ collection, method, args }) => [collection, method, args[0]])).toEqual([
      ['draft_picks', 'delete', 'pick-1'],
      ['draft_picks', 'delete', 'pick-2'],
      ['auctions', 'delete', 'active-auction'],
      ['auctions', 'create', expect.any(Object)],
      ['auction_teams', 'create', expect.any(Object)],
    ]);
  });

  it('does not issue individual lifecycle writes when the transaction fails', async () => {
    const fake = createPocketBase([]);
    fake.batch.send.mockRejectedValue(new Error('batch failed'));
    auth.requireAuth.mockResolvedValue({ pb: fake.pb, userId: 'user-1' });

    await expect(replaceAuction('active-auction', input('mock'), 'complete')).rejects.toThrow(
      'Failed to replace auction'
    );

    expect(fake.auctions.update).not.toHaveBeenCalled();
    expect(fake.auctions.create).not.toHaveBeenCalled();
    expect(fake.auctionTeams.create).not.toHaveBeenCalled();
  });

  it('maps a replacement unique constraint to the active-draft conflict', async () => {
    const fake = createPocketBase([]);
    fake.batch.send.mockRejectedValue(uniqueConstraintError('batch'));
    auth.requireAuth.mockResolvedValue({ pb: fake.pb, userId: 'user-1' });

    await expect(replaceAuction('active-auction', input('mock'), 'complete')).rejects.toThrow(
      'Complete or delete the active mock draft before starting a new auction'
    );
  });
});
