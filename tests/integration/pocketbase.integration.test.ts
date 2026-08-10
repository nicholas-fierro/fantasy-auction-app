import fs from 'node:fs';
import PocketBase, { ClientResponseError, type CollectionModel, type RecordModel } from 'pocketbase';
import { beforeAll, describe, expect, it } from 'vitest';

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required; run npm run test:integration`);
  return value;
}

const baselineUrl = env('PB_BASELINE_URL');
const integrationUrl = env('PB_INTEGRATION_URL');
const adminEmail = env('PB_INTEGRATION_ADMIN_EMAIL');
const adminPassword = env('PB_INTEGRATION_ADMIN_PASSWORD');

const baselineAdmin = new PocketBase(baselineUrl);
const admin = new PocketBase(integrationUrl);

beforeAll(async () => {
  await Promise.all([
    baselineAdmin.collection('_superusers').authWithPassword(adminEmail, adminPassword),
    admin.collection('_superusers').authWithPassword(adminEmail, adminPassword),
  ]);
});

function compactRule(rule: unknown): unknown {
  return typeof rule === 'string' ? rule.replace(/\s+/g, ' ').trim() : rule;
}

function normalizedCollection(collection: Record<string, any>) {
  const fields = collection.fields
    .map(({ id: _id, ...field }: Record<string, any>) => field)
    .sort((a: Record<string, any>, b: Record<string, any>) => a.name.localeCompare(b.name));
  const indexes = collection.indexes
    .map((index: string) => index.replace(/`/g, '').replace(/\s+/g, ' ').trim())
    .sort();
  return {
    name: collection.name,
    type: collection.type,
    system: collection.system,
    listRule: compactRule(collection.listRule),
    viewRule: compactRule(collection.viewRule),
    createRule: compactRule(collection.createRule),
    updateRule: compactRule(collection.updateRule),
    deleteRule: compactRule(collection.deleteRule),
    fields,
    indexes,
    authRule: collection.authRule,
    manageRule: collection.manageRule,
    passwordAuth: collection.passwordAuth,
    authToken: collection.authToken,
  };
}

function indexNames(collection: Record<string, any>): string[] {
  return collection.indexes
    .map((index: string) => index.match(/INDEX\s+`([^`]+)`/i)?.[1])
    .filter(Boolean)
    .sort();
}

const expectedCollections = [
  'auction_nomination_events',
  'auction_teams',
  'auctions',
  'draft_picks',
  'fantasy_teams',
  'invites',
  'league_members',
  'leagues',
  'player_game_logs',
  'player_seasons',
  'players',
  'team_profiles',
  'users',
  'watchlist',
].sort();

const expectedIndexes: Record<string, string[]> = {
  users: ['idx_email__pb_users_auth_', 'idx_tokenKey__pb_users_auth_'],
  players: ['idx_players_gsis_id'],
  auctions: ['idx_auctions_active_user_type'],
  draft_picks: ['idx_draft_picks_auction_pick_order', 'idx_draft_picks_auction_player'],
  watchlist: ['idx_watchlist_player_user'],
  auction_teams: ['idx_auction_teams_auction_team'],
  player_game_logs: [
    'idx_player_game_logs_player_game',
    'idx_player_game_logs_player_season_week',
  ],
  player_seasons: ['idx_player_seasons_player_year', 'idx_player_seasons_year'],
  team_profiles: ['idx_team_profiles_user_team'],
  league_members: [
    'idx_league_members_invite',
    'idx_league_members_league_team',
    'idx_league_members_league_user',
  ],
  invites: ['idx_invites_token'],
  auction_nomination_events: [
    'idx_auction_nomination_events_latest',
    'idx_auction_nomination_events_order',
  ],
};

const expectedRules: Record<string, Partial<Record<'listRule' | 'viewRule' | 'createRule' | 'updateRule' | 'deleteRule', string | null>>> = {
  users: {
    listRule: 'id = @request.auth.id',
    viewRule: 'id = @request.auth.id',
    createRule: null,
  },
  auctions: {
    listRule: '@request.auth.id != "" && (user = @request.auth.id || league.commissioner = @request.auth.id || (type = "official" && league.league_members_via_league.user ?= @request.auth.id) || (type = "official" && external = true))',
    createRule: '@request.auth.id != "" && user = @request.auth.id && (type != "official" || league.commissioner = @request.auth.id) && @request.body.external != true',
    // Only a superuser may set `external` — it gates a shared read clause.
    updateRule: '(user = @request.auth.id || league.commissioner = @request.auth.id) && @request.body.external != true',
  },
  draft_picks: {
    listRule: '@request.auth.id != "" && (auction_id.user = @request.auth.id || auction_id.league.commissioner = @request.auth.id || (auction_id.type = "official" && auction_id.league.league_members_via_league.user ?= @request.auth.id) || (auction_id.type = "official" && auction_id.external = true))',
    createRule: '@request.auth.id != "" && auction_id.status = "active" && (auction_id.user = @request.auth.id || auction_id.league.commissioner = @request.auth.id || (auction_id.type = "official" && fantasy_team_id.league = auction_id.league && fantasy_team_id.league_members_via_fantasy_team.user ?= @request.auth.id))',
  },
  auction_teams: {
    createRule: '@request.auth.id != "" && (auction_id.user = @request.auth.id || auction_id.league.commissioner = @request.auth.id)',
  },
  watchlist: {
    listRule: 'user = @request.auth.id',
    createRule: '@request.auth.id != "" && user = @request.auth.id',
  },
  fantasy_teams: {
    updateRule: 'league.commissioner = @request.auth.id',
  },
  players: {
    createRule: '@collection.leagues.commissioner ?= @request.auth.id',
  },
  player_seasons: {
    createRule: '@collection.leagues.commissioner ?= @request.auth.id',
  },
  player_game_logs: {
    listRule: '@request.auth.id != ""',
    viewRule: '@request.auth.id != ""',
    createRule: null,
    updateRule: null,
    deleteRule: null,
  },
  team_profiles: {
    listRule: 'user = @request.auth.id',
  },
  leagues: {
    listRule: 'commissioner = @request.auth.id || league_members_via_league.user ?= @request.auth.id',
    createRule: null,
  },
  league_members: {
    listRule: 'league.commissioner = @request.auth.id || league.league_members_via_league.user ?= @request.auth.id',
  },
  invites: {
    listRule: 'league.commissioner = @request.auth.id',
  },
  auction_nomination_events: {
    updateRule: null,
    deleteRule: null,
  },
};

describe('empty-instance migrations', () => {
  it('applies the baseline with all 14 app collections, indexes, and rules', async () => {
    const collections = (await baselineAdmin.collections.getFullList()) as unknown as Record<string, any>[];
    const appCollections = collections.filter((collection) => !collection.system);
    expect(appCollections.map((collection) => collection.name).sort()).toEqual(expectedCollections);

    const byName = new Map(appCollections.map((collection) => [collection.name, collection]));
    for (const [name, names] of Object.entries(expectedIndexes)) {
      expect(indexNames(byName.get(name)!)).toEqual(names.slice().sort());
    }
    for (const [name, rules] of Object.entries(expectedRules)) {
      const collection = byName.get(name)!;
      for (const [key, expected] of Object.entries(rules)) {
        expect(compactRule(collection[key]), `${name}.${key}`).toBe(expected);
      }
    }
    expect(byName.get('players')!.fields.map((field: Record<string, any>) => field.name)).toContain('gsis_id');
    expect(byName.get('player_game_logs')!.fields.map((field: Record<string, any>) => field.name)).toEqual(
      expect.arrayContaining([
        'player_id', 'season', 'week', 'season_type', 'game_id', 'team', 'opponent', 'stats',
      ]),
    );
  });

  it('matches the schema produced by the full incremental chain', async () => {
    const [baselineCollections, incrementalCollections] = await Promise.all([
      baselineAdmin.collections.getFullList(),
      admin.collections.getFullList(),
    ]);
    const normalize = (collections: CollectionModel[]) =>
      collections
        .filter((collection) => !collection.system)
        .map((collection) => normalizedCollection(collection as unknown as Record<string, any>))
        .sort((a, b) => a.name.localeCompare(b.name));
    expect(normalize(incrementalCollections)).toEqual(normalize(baselineCollections));
  });
});

interface Fixture {
  userA: RecordModel;
  userB: RecordModel;
  userC: RecordModel;
  clientA: PocketBase;
  clientB: PocketBase;
  clientC: PocketBase;
  league: RecordModel;
  teamA: RecordModel;
  teamB: RecordModel;
  players: RecordModel[];
  officialAuction: RecordModel;
  mockAuction: RecordModel;
  officialTeamA: RecordModel;
  officialTeamB: RecordModel;
  mockTeamA: RecordModel;
  nominationAuction: RecordModel;
  orderingAuction: RecordModel;
}

let fixture: Fixture;

async function createFixture(): Promise<Fixture> {
  const password = `${adminPassword}Aa1!`;
  const createUser = (email: string, name: string) =>
    admin.collection('users').create(
      { email, name, password, passwordConfirm: password, verified: true },
      { requestKey: null }
    );
  const [userA, userB, userC] = await Promise.all([
    createUser('integration-a@example.test', 'Integration A'),
    createUser('integration-b@example.test', 'Integration B'),
    createUser('integration-c@example.test', 'Integration C'),
  ]);
  const [clientA, clientB, clientC] = await Promise.all([
    admin.collection('users').impersonate(userA.id, 3600),
    admin.collection('users').impersonate(userB.id, 3600),
    admin.collection('users').impersonate(userC.id, 3600),
  ]);

  const league = await admin.collection('leagues').create({
    name: 'Integration League',
    commissioner: userA.id,
    settings: { paidAuctionSlots: 7 },
  });
  const [teamA, teamB] = await Promise.all([
    admin.collection('fantasy_teams').create({ name: 'Team A', league: league.id }, { requestKey: null }),
    admin.collection('fantasy_teams').create({ name: 'Team B', league: league.id }, { requestKey: null }),
  ]);
  await Promise.all([
    admin.collection('league_members').create(
      { league: league.id, user: userA.id, fantasy_team: teamA.id },
      { requestKey: null }
    ),
    admin.collection('league_members').create(
      { league: league.id, user: userB.id, fantasy_team: teamB.id },
      { requestKey: null }
    ),
  ]);

  const players = await Promise.all(
    Array.from({ length: 12 }, (_, index) =>
      admin.collection('players').create(
        { name: `Integration Player ${index + 1}`, position: 'RB' },
        { requestKey: null }
      )
    )
  );
  const createAuction = (data: Record<string, unknown>) =>
    admin.collection('auctions').create(data, { requestKey: null });
  // idx_auctions_active_user_type allows only one active auction per owner and
  // type, so each active official draft needs its own owner. userA stays
  // commissioner, so clientA still reaches every one of them via that lane.
  const [officialAuction, mockAuction, nominationAuction, orderingAuction] = await Promise.all([
    createAuction({
      name: 'Official Integration Draft', year: 2026, status: 'active', type: 'official', user: userA.id, league: league.id,
    }),
    createAuction({
      name: 'Private Mock Draft', year: 2026, status: 'active', type: 'mock', user: userA.id, league: league.id,
    }),
    createAuction({
      name: 'Nomination Hook Draft', year: 2026, status: 'active', type: 'official', user: userB.id, league: league.id,
    }),
    createAuction({
      name: 'Ordering Hook Draft', year: 2026, status: 'active', type: 'official', user: userC.id, league: league.id,
    }),
  ]);

  const createAuctionTeam = (auction: RecordModel, team: RecordModel, draftOrder: number) =>
    admin.collection('auction_teams').create(
      { auction_id: auction.id, fantasy_team_id: team.id, draft_order: draftOrder },
      { requestKey: null }
    );
  const [officialTeamA, officialTeamB, mockTeamA] = await Promise.all([
    createAuctionTeam(officialAuction, teamA, 1),
    createAuctionTeam(officialAuction, teamB, 2),
    createAuctionTeam(mockAuction, teamA, 1),
    createAuctionTeam(nominationAuction, teamB, 1),
    createAuctionTeam(nominationAuction, teamA, 2),
    createAuctionTeam(orderingAuction, teamA, 1),
    createAuctionTeam(orderingAuction, teamB, 2),
  ]);

  return {
    userA, userB, userC, clientA: clientA as PocketBase, clientB: clientB as PocketBase,
    clientC: clientC as PocketBase, league, teamA, teamB, players, officialAuction, mockAuction,
    officialTeamA, officialTeamB, mockTeamA, nominationAuction, orderingAuction,
  };
}

beforeAll(async () => {
  fixture = await createFixture();
});

async function expectApiFailure(promise: Promise<unknown>, statuses = [400, 403, 404]) {
  try {
    await promise;
    throw new Error('Expected PocketBase request to fail');
  } catch (error) {
    expect(error).toBeInstanceOf(ClientResponseError);
    expect(statuses).toContain((error as ClientResponseError).status);
  }
}

describe('player game logs', () => {
  it('allows authenticated reads while keeping writes superuser-only', async () => {
    const payload = {
      player_id: fixture.players[0].id,
      season: 2025,
      week: 1,
      season_type: 'REG',
      game_id: '2025_01_TEST_TEST',
      team: 'TEST',
      opponent: 'TEST',
      stats: { receptions: 2, receiving_yards: 20 },
    };
    const record = await admin.collection('player_game_logs').create(payload);

    await expect(fixture.clientA.collection('player_game_logs').getOne(record.id)).resolves.toMatchObject({
      game_id: payload.game_id,
    });
    await expectApiFailure(fixture.clientA.collection('player_game_logs').create({
      ...payload,
      game_id: '2025_02_TEST_TEST',
    }));
    await expectApiFailure(fixture.clientA.collection('player_game_logs').update(record.id, {
      week: 2,
    }));
    await expectApiFailure(fixture.clientA.collection('player_game_logs').delete(record.id));
    await expectApiFailure(admin.collection('player_game_logs').create(payload), [400]);
  });
});

describe('PocketBase hooks', () => {
  it('starts without hook load errors', () => {
    for (const path of env('PB_INTEGRATION_LOGS').split(':')) {
      expect(fs.readFileSync(path, 'utf8')).not.toMatch(
        /failed to (load|register).*hook|hook.*(syntax|reference).*error|error.*pb_hooks/i
      );
    }
  });

  it('completes an auction at its JSON roster capacity', async () => {
    const { clientB, userA, userB, players } = fixture;
    const league = await admin.collection('leagues').create({
      name: 'Custom Roster Hook League',
      commissioner: userA.id,
      settings: { starterPositions: ['QB'], benchSize: 1 },
    }, { requestKey: null });
    const team = await admin.collection('fantasy_teams').create({
      name: 'Custom Roster Team', league: league.id,
    }, { requestKey: null });
    const auction = await admin.collection('auctions').create({
      name: 'Custom Roster Hook Draft', year: 2026, status: 'active', type: 'mock',
      user: userB.id, league: league.id,
    }, { requestKey: null });
    await admin.collection('auction_teams').create({
      auction_id: auction.id, fantasy_team_id: team.id, draft_order: 1,
    }, { requestKey: null });

    await clientB.collection('draft_picks').create({
      auction_id: auction.id, fantasy_team_id: team.id, player_id: players[0].id, price: 1,
    }, { requestKey: null });
    expect((await admin.collection('auctions').getOne(auction.id)).status).toBe('active');

    await clientB.collection('draft_picks').create({
      auction_id: auction.id, fantasy_team_id: team.id, player_id: players[1].id, price: 1,
    }, { requestKey: null });
    expect((await admin.collection('auctions').getOne(auction.id)).status).toBe('completed');
  });

  it('enforces nomination permissions and assigns nomination sequence fields', async () => {
    const { clientA, clientB, userA, userB, nominationAuction, players } = fixture;
    const nomination = await clientB.collection('auction_nomination_events').create({
      auction_id: nominationAuction.id,
      player_id: players[9].id,
      user: userB.id,
      action: 'nominate',
      event_order: 99,
      pick_count: 99,
    });
    expect(nomination.event_order).toBe(1);
    expect(nomination.pick_count).toBe(0);

    const clear = await clientB.collection('auction_nomination_events').create({
      auction_id: nominationAuction.id,
      player_id: '',
      user: userB.id,
      action: 'clear',
    });
    expect(clear.event_order).toBe(2);
    expect(clear.pick_count).toBe(0);

    await clientA.collection('auction_nomination_events').create({
      auction_id: nominationAuction.id,
      player_id: players[10].id,
      user: userA.id,
      action: 'nominate',
    });
    await expectApiFailure(clientB.collection('auction_nomination_events').create({
      auction_id: nominationAuction.id,
      player_id: '',
      user: userB.id,
      action: 'clear',
    }), [403]);
  });
});

describe('live invite concurrency', () => {
  it('commits exactly one atomic redemption and rolls back the loser', async () => {
    const invite = await admin.collection('invites').create({
      league: fixture.league.id,
      token: 'integration-race-token',
      expires: new Date(Date.now() + 60_000).toISOString(),
    });
    const candidates = [
      { id: 'raceuser0000001', email: 'race-one@example.test' },
      { id: 'raceuser0000002', email: 'race-two@example.test' },
    ];
    const sends = candidates.map((candidate) => {
      const batch = admin.createBatch();
      batch.collection('users').create({
        id: candidate.id,
        email: candidate.email,
        password: `${adminPassword}Bb2!`,
        passwordConfirm: `${adminPassword}Bb2!`,
        verified: true,
      });
      batch.collection('league_members').create({
        league: fixture.league.id,
        user: candidate.id,
        invite: invite.id,
      });
      // Parallel calls to the same /api/batch endpoint must opt out of SDK auto-cancellation.
      return batch.send({ requestKey: null });
    });

    const results = await Promise.allSettled(sends);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);

    const memberships = await admin.collection('league_members').getFullList({
      filter: admin.filter('invite = {:invite}', { invite: invite.id }),
    });
    const users = await admin.collection('users').getFullList({
      filter: candidates.map((candidate) => `id = "${candidate.id}"`).join(' || '),
    });
    expect(memberships).toHaveLength(1);
    expect(users).toHaveLength(1);
    expect(memberships[0].user).toBe(users[0].id);
  });
});

describe('authorization rules (AD-2 and AD-18)', () => {
  it('isolates private records while preserving official read and two-lane writes', async () => {
    const {
      clientA, clientB, clientC, userA, userB, teamA, teamB, players,
      officialAuction, mockAuction, officialTeamA, mockTeamA,
    } = fixture;

    expect((await clientB.collection('auctions').getOne(officialAuction.id)).id).toBe(officialAuction.id);
    await expectApiFailure(clientB.collection('auctions').getOne(mockAuction.id), [404]);
    await expectApiFailure(clientC.collection('auctions').getOne(officialAuction.id), [404]);
    await expectApiFailure(clientB.collection('auctions').update(mockAuction.id, { name: 'forbidden' }), [404]);
    await expectApiFailure(clientB.collection('auctions').create({
      name: 'Foreign Auction', year: 2026, status: 'active', type: 'mock', user: userA.id,
    }), [400, 403]);

    const memberPick = await clientB.collection('draft_picks').create({
      auction_id: officialAuction.id,
      fantasy_team_id: teamB.id,
      player_id: players[0].id,
      price: 11,
    });
    const ownerPick = await clientA.collection('draft_picks').create({
      auction_id: officialAuction.id,
      fantasy_team_id: teamA.id,
      player_id: players[1].id,
      price: 12,
    });
    await expectApiFailure(clientB.collection('draft_picks').create({
      auction_id: officialAuction.id,
      fantasy_team_id: teamA.id,
      player_id: players[2].id,
      price: 13,
    }), [400, 403]);
    await expectApiFailure(clientB.collection('draft_picks').update(memberPick.id, { price: 20 }), [404]);
    expect((await clientA.collection('draft_picks').update(ownerPick.id, { price: 14 })).price).toBe(14);

    const mockPick = await clientA.collection('draft_picks').create({
      auction_id: mockAuction.id,
      fantasy_team_id: teamA.id,
      player_id: players[3].id,
      price: 9,
    });
    await expectApiFailure(clientB.collection('draft_picks').getOne(mockPick.id), [404]);
    await expectApiFailure(clientC.collection('draft_picks').getOne(memberPick.id), [404]);

    expect(await clientB.collection('auction_teams').getFullList({
      filter: clientB.filter('auction_id = {:auction}', { auction: officialAuction.id }),
    })).toHaveLength(2);
    await expectApiFailure(clientB.collection('auction_teams').getOne(mockTeamA.id), [404]);
    await expectApiFailure(clientB.collection('auction_teams').update(officialTeamA.id, { draft_order: 3 }), [404]);
    expect((await clientA.collection('auction_teams').update(officialTeamA.id, { draft_order: 3 })).draft_order).toBe(3);

    const watch = await clientA.collection('watchlist').create({ user: userA.id, player_id: players[4].id, watch_order: 1 });
    expect(await clientB.collection('watchlist').getFullList()).toHaveLength(0);
    await expectApiFailure(clientB.collection('watchlist').getOne(watch.id), [404]);
    await expectApiFailure(clientB.collection('watchlist').create({ user: userA.id, player_id: players[5].id }), [400, 403]);
    expect((await clientB.collection('watchlist').create({ user: userB.id, player_id: players[5].id })).user).toBe(userB.id);
  });

  it('shares external boards with members only, and never lets a client mark one', async () => {
    const { clientA, clientB, clientC, players, league, userA } = fixture;

    // Only a superuser can create an external board — the importer's job.
    const board = await admin.collection('auctions').create({
      name: 'Outside League 2026', year: 2026, status: 'completed', type: 'official', external: true,
    });
    const boardPick = await admin.collection('draft_picks').create({
      auction_id: board.id, player_id: players[6].id, price: 55, pick_order: 1,
    });

    // Every authenticated user reads it — that is what keeps the CLI and the
    // in-app recalculation pricing off identical history.
    for (const client of [clientA, clientB, clientC]) {
      expect((await client.collection('auctions').getOne(board.id)).id).toBe(board.id);
      expect((await client.collection('draft_picks').getOne(boardPick.id)).id).toBe(boardPick.id);
    }

    // A guest reads nothing. The read clause carries no auth comparison of its
    // own, so without the wrapping `@request.auth.id != ""` this board and all
    // of its picks would be world-readable — as would any league-less auction,
    // whose `league.commissioner` resolves null and compares equal to "".
    const guest = new PocketBase(integrationUrl);
    await expectApiFailure(guest.collection('auctions').getOne(board.id), [404]);
    await expectApiFailure(guest.collection('draft_picks').getOne(boardPick.id), [404]);
    expect(await guest.collection('auctions').getFullList()).toHaveLength(0);

    // A member cannot mint one, nor promote an auction they already own —
    // either would publish that auction and its picks to the whole instance.
    await expectApiFailure(clientA.collection('auctions').create({
      name: 'Self-published', year: 2026, status: 'completed', type: 'official',
      user: userA.id, league: league.id, external: true,
    }), [400, 403]);

    const owned = await clientA.collection('auctions').create({
      name: 'Ordinary Mock', year: 2026, status: 'completed', type: 'mock',
      user: userA.id, league: league.id,
    });
    await expectApiFailure(clientA.collection('auctions').update(owned.id, { external: true }), [400, 403, 404]);
    // …while an ordinary update to the same record still succeeds.
    expect((await clientA.collection('auctions').update(owned.id, { name: 'Renamed' })).name).toBe('Renamed');

    await admin.collection('auctions').delete(owned.id);
    await admin.collection('auctions').delete(board.id);
  });

  it('rejects a second active auction of the same type for one owner', async () => {
    const { clientA, userA, league } = fixture;
    await expectApiFailure(clientA.collection('auctions').create({
      name: 'Duplicate Active Official', year: 2026, status: 'active', type: 'official',
      user: userA.id, league: league.id,
    }), [400]);
    // The index is partial on status = 'active', so a completed one still fits.
    const completed = await clientA.collection('auctions').create({
      name: 'Completed Official', year: 2026, status: 'completed', type: 'official',
      user: userA.id, league: league.id,
    });
    await admin.collection('auctions').delete(completed.id);
  });
});

describe('server-assigned pick ordering (AD-19)', () => {
  it('assigns unique contiguous order under concurrent creates', async () => {
    const { clientA, orderingAuction, teamA, players } = fixture;
    const createPick = (player: RecordModel) => clientA.collection('draft_picks').create({
      auction_id: orderingAuction.id,
      fantasy_team_id: teamA.id,
      player_id: player.id,
      price: 5,
      pick_order: 99,
    }, { requestKey: null });
    const candidates = players.slice(6, 11);
    const firstPass = await Promise.allSettled(candidates.map(createPick));

    for (let index = 0; index < firstPass.length; index++) {
      if (firstPass[index].status === 'rejected') await createPick(candidates[index]);
    }

    const picks = await admin.collection('draft_picks').getFullList({
      filter: admin.filter('auction_id = {:auction}', { auction: orderingAuction.id }),
      sort: 'pick_order',
    });
    expect(picks).toHaveLength(candidates.length);
    expect(picks.map((pick) => pick.pick_order)).toEqual([1, 2, 3, 4, 5]);
    expect(new Set(picks.map((pick) => pick.pick_order)).size).toBe(picks.length);
  });
});

describe('login rate-limit hook', () => {
  it('blocks the eleventh users password attempt in the fixed window', async () => {
    await admin.collection('users').create({
      email: 'rate-limit@example.test',
      password: `${adminPassword}Cc3!`,
      passwordConfirm: `${adminPassword}Cc3!`,
      verified: true,
    });
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 11; attempt++) {
      const response = await fetch(`${integrationUrl}/api/collections/users/auth-with-password`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ identity: 'rate-limit@example.test', password: 'wrong-password' }),
      });
      statuses.push(response.status);
    }
    expect(statuses.slice(0, 10)).toEqual(Array(10).fill(400));
    expect(statuses[10]).toBe(429);
  });
});
