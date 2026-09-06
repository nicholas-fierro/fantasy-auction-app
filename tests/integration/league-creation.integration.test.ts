import PocketBase, { type RecordModel } from 'pocketbase';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_ROSTER_SETTINGS } from '@/lib/roster';
import type {
  CreatedLeague,
  CreateLeagueInput,
} from '@/hooks/use-create-league';

const admin = new PocketBase(process.env.PB_INTEGRATION_URL);
let caller: PocketBase;
let outsider: PocketBase;
const users: RecordModel[] = [];
const created: CreatedLeague[] = [];

beforeAll(async () => {
  await admin
    .collection('_superusers')
    .authWithPassword(
      process.env.PB_INTEGRATION_ADMIN_EMAIL!,
      process.env.PB_INTEGRATION_ADMIN_PASSWORD!
    );
  for (const name of ['creator', 'creation-outsider']) {
    const password = `${process.env.PB_INTEGRATION_ADMIN_PASSWORD}Aa1!`;
    users.push(
      await admin.collection('users').create({
        email: `${name}@example.test`,
        password,
        passwordConfirm: password,
        verified: true,
      })
    );
  }
  caller = await admin.collection('users').impersonate(users[0].id, 3600);
  outsider = await admin.collection('users').impersonate(users[1].id, 3600);
});

afterAll(async () => {
  for (const result of created) {
    await admin.collection('league_members').delete(result.membership.id);
    for (const team of await admin
      .collection('fantasy_teams')
      .getFullList({
        filter: admin.filter('league = {:id}', { id: result.league.id }),
      })) {
      await admin.collection('fantasy_teams').delete(team.id);
    }
    await admin.collection('leagues').delete(result.league.id);
  }
  for (const user of users) await admin.collection('users').delete(user.id);
});

function input(): CreateLeagueInput {
  return {
    name: ' Creation league ',
    teamNames: [' North ', 'South', 'East', 'West'],
    commissionerTeamIndex: 2,
    settings: {
      ...DEFAULT_ROSTER_SETTINGS,
      starterPositions: [...DEFAULT_ROSTER_SETTINGS.starterPositions],
    },
  };
}

async function create(body: unknown, client = caller) {
  const result = await client.send<CreatedLeague>(
    '/api/league-admin/create-league',
    { method: 'POST', body }
  );
  created.push(result);
  return result;
}

async function counts() {
  const result: Record<string, number> = {};
  for (const name of ['leagues', 'fantasy_teams', 'league_members']) {
    result[name] = (await admin.collection(name).getList(1, 1)).totalItems;
  }
  return result;
}

describe('authenticated atomic league creation', () => {
  it('rejects guests and non-user auth without writes', async () => {
    const before = await counts();
    await expect(
      create(input(), new PocketBase(process.env.PB_INTEGRATION_URL))
    ).rejects.toMatchObject({ status: 401 });
    await expect(create(input(), admin)).rejects.toMatchObject({ status: 401 });
    expect(await counts()).toEqual(before);
  });

  it('lets an authenticated non-member become commissioner, with scoped teams and an immediately readable membership', async () => {
    expect(
      await caller.collection('league_members').getFullList()
    ).toHaveLength(0);
    const result = await create({
      ...input(),
      commissioner: users[1].id,
      user: users[1].id,
      league: 'ignored',
      settings: { ...input().settings, privileged: true },
    });
    expect(result.league).toMatchObject({
      name: 'Creation league',
      commissioner: users[0].id,
      settings: DEFAULT_ROSTER_SETTINGS,
    });
    expect(result.league.settings).not.toHaveProperty('privileged');
    const league = await caller.collection('leagues').getOne(result.league.id);
    expect(league.commissioner).toBe(users[0].id);
    const teams = await caller
      .collection('fantasy_teams')
      .getFullList({
        filter: caller.filter('league = {:id}', { id: league.id }),
      });
    expect(teams.map((team) => team.name).sort()).toEqual([
      'East',
      'North',
      'South',
      'West',
    ]);
    expect(teams.every((team) => team.league === league.id)).toBe(true);
    const membership = await caller
      .collection('league_members')
      .getOne(result.membership.id, { expand: 'league,fantasy_team' });
    expect(membership.user).toBe(users[0].id);
    expect(membership.fantasy_team).toBe(
      teams.find((team) => team.name === 'East')!.id
    );
    expect(membership.expand?.league.id).toBe(league.id);
    expect(membership.expand?.fantasy_team.name).toBe('East');
    await expect(
      outsider.collection('leagues').getOne(league.id)
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      outsider.collection('fantasy_teams').getOne(teams[0].id)
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      outsider.collection('league_members').getOne(membership.id)
    ).rejects.toMatchObject({ status: 404 });
  });

  it.each(['snake', 'auction', 'hybrid'] as const)(
    'creates a second %s league with its own team bindings',
    async (draftFormat) => {
      const body = input();
      body.settings = {
        ...body.settings,
        draftFormat,
        scoringFormat: 'ppr',
        ...(draftFormat === 'snake'
          ? { paidAuctionSlots: 0, budget: 0, minimumBid: 0 }
          : {}),
      };
      const result = await create(body);
      expect(result.league.settings).toEqual(body.settings);
      expect(
        created.filter(
          (row) =>
            row.membership.fantasyTeamId === result.membership.fantasyTeamId
        )
      ).toHaveLength(1);
    }
  );

  const invalidCases: [string, (body: Record<string, any>) => void][] = [
    [
      'blank league name',
      (b) => {
        b.name = ' ';
      },
    ],
    [
      'non-string league name',
      (b) => {
        b.name = {};
      },
    ],
    [
      'long name',
      (b) => {
        b.name = 'a'.repeat(101);
      },
    ],
    [
      'one team',
      (b) => {
        b.teamNames = ['Only'];
      },
    ],
    [
      'too many teams',
      (b) => {
        b.teamNames = Array.from({ length: 33 }, (_, i) => `Team ${i}`);
      },
    ],
    [
      'non-array teams',
      (b) => {
        b.teamNames = 'North';
      },
    ],
    [
      'blank team',
      (b) => {
        b.teamNames[1] = ' ';
      },
    ],
    [
      'non-string team',
      (b) => {
        b.teamNames[1] = 2;
      },
    ],
    [
      'duplicate team names',
      (b) => {
        b.teamNames[1] = 'north';
      },
    ],
    [
      'missing selection',
      (b) => {
        delete b.commissionerTeamIndex;
      },
    ],
    [
      'outside selection',
      (b) => {
        b.commissionerTeamIndex = 4;
      },
    ],
    [
      'fractional selection',
      (b) => {
        b.commissionerTeamIndex = 1.5;
      },
    ],
    [
      'missing settings',
      (b) => {
        delete b.settings;
      },
    ],
    [
      'invalid scoring',
      (b) => {
        b.settings.scoringFormat = 'bogus';
      },
    ],
    [
      'invalid format',
      (b) => {
        b.settings.draftFormat = 'bogus';
      },
    ],
    [
      'negative budget',
      (b) => {
        b.settings.budget = -1;
      },
    ],
    [
      'string budget',
      (b) => {
        b.settings.budget = '200';
      },
    ],
    [
      'null budget',
      (b) => {
        b.settings.budget = null;
      },
    ],
    [
      'excessive budget',
      (b) => {
        b.settings.budget = 1000001;
      },
    ],
    [
      'zero minimum',
      (b) => {
        b.settings.minimumBid = 0;
      },
    ],
    [
      'insufficient budget',
      (b) => {
        b.settings.budget = 6;
      },
    ],
    [
      'zero paid slots',
      (b) => {
        b.settings.paidAuctionSlots = 0;
      },
    ],
    [
      'fractional slots',
      (b) => {
        b.settings.paidAuctionSlots = 1.5;
      },
    ],
    [
      'too many paid slots',
      (b) => {
        b.settings.paidAuctionSlots = 16;
      },
    ],
    [
      'paid snake slots',
      (b) => {
        b.settings.draftFormat = 'snake';
      },
    ],
    [
      'negative bench',
      (b) => {
        b.settings.benchSize = -1;
      },
    ],
    [
      'fractional bench',
      (b) => {
        b.settings.benchSize = 1.5;
      },
    ],
    [
      'excessive bench',
      (b) => {
        b.settings.benchSize = 51;
      },
    ],
    [
      'empty starters',
      (b) => {
        b.settings.starterPositions = [];
      },
    ],
    [
      'non-array starters',
      (b) => {
        b.settings.starterPositions = 'QB';
      },
    ],
    [
      'invalid position',
      (b) => {
        b.settings.starterPositions = ['SUPERFLEX'];
      },
    ],
    [
      'too many starters',
      (b) => {
        b.settings.starterPositions = Array(51).fill('QB');
      },
    ],
  ];
  it.each(invalidCases)(
    'rejects %s without partial records',
    async (_name, modify) => {
      const body = input();
      modify(body);
      const before = await counts();
      await expect(create(body)).rejects.toMatchObject({
        status: 400,
        response: { code: 'invalid_input' },
      });
      expect(await counts()).toEqual(before);
    }
  );

  it.each(['fantasy_teams', 'league_members'])(
    'rolls back all writes when saving %s fails after league creation',
    async (collectionName) => {
      // Temporary schema constraint on the disposable test instance, not a
      // production failure switch. Membership failure happens after every team
      // save, so this proves rollback of the full record graph.
      const collection = await admin.collections.getOne(collectionName);
      const before = await counts();
      try {
        await admin.collections.update(collection.id, {
          fields: [
            ...collection.fields,
            { name: 'creation_test_required', type: 'text', required: true },
          ],
        });
        await expect(create(input())).rejects.toMatchObject({
          status: 500,
          response: { code: 'creation_failed' },
        });
        expect(await counts()).toEqual(before);
      } finally {
        await admin.collections.update(collection.id, {
          fields: collection.fields,
        });
      }
      // The same request succeeds once the forced failure is gone.
      await create(input());
    }
  );
});
