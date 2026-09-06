import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { FantasyTeam } from '@/server/types/fantasy-team';
import { getNominatorForPick } from './draft-turn';
import { calculateCurrentSnakeTeam } from './snake-draft';

type StubValue = string | number | null | undefined;
type StubRow = Record<string, StubValue>;
type StubRecord = ReturnType<typeof record>;

interface FindRecordsContract {
  collection: string;
  filter: string;
  sort: string;
  limit: number;
  offset: number;
  params: { auctionId: string };
}

interface NominationVector {
  name: string;
  teams: Array<{ id: string; draft_order: number }>;
  picks: Array<{ fantasy_team_id: string; price: number | null }>;
  paidAuctionSlots: number;
  expected: string | null;
}

interface SnakeVector {
  name: string;
  teams: FantasyTeam[];
  totalPicks: number;
  paidAuctionSlots: number;
  expectedCurrent: string | null;
  expectedNext: string | null;
}

const here = dirname(fileURLToPath(import.meta.url));
const nominationHookPath = resolve(
  here,
  '../../pb_hooks/auction_nomination_permissions.pb.js',
);
const pickHookPath = resolve(here, '../../pb_hooks/draft_picks_pick_order.pb.js');

function extractMarkedFunction<T extends (...args: never[]) => unknown>(
  filePath: string,
  markerName: string,
  functionName: string,
): T {
  const normalizedSource = readFileSync(filePath, 'utf8').replace(/\r\n?/g, '\n');
  const startMarker = `// drift-guard:start ${markerName}`;
  const endMarker = `// drift-guard:end ${markerName}`;
  const lines = normalizedSource.split('\n');
  const startLines = lines
    .map((line, index) => line.trim() === startMarker ? index : -1)
    .filter(index => index >= 0);
  const endLines = lines
    .map((line, index) => line.trim() === endMarker ? index : -1)
    .filter(index => index >= 0);

  expect(startLines, `${startMarker} must be one unique complete line`).toEqual([
    expect.any(Number),
  ]);
  expect(endLines, `${endMarker} must be one unique complete line`).toEqual([
    expect.any(Number),
  ]);

  const startLine = startLines[0];
  const endLine = endLines[0];
  expect(endLine, `${endMarker} must follow ${startMarker}`).toBeGreaterThan(startLine);

  const body = lines.slice(startLine + 1, endLine).join('\n');
  expect(body).toMatch(new RegExp(`\\bfunction\\s+${functionName}\\s*\\(`));
  return new Function(`${body}\nreturn ${functionName};`)() as T;
}

function record(values: StubRow) {
  return {
    id: values.id == null ? '' : String(values.id),
    getString(field: string) {
      const value = values[field];
      return value == null ? '' : String(value);
    },
    getInt(field: string) {
      return Math.trunc(Number(values[field] ?? 0));
    },
    getFloat(field: string) {
      return Number(values[field] ?? 0);
    },
  };
}

function assertFindRecordsContract(
  args: unknown[],
  expected: FindRecordsContract,
): void {
  expect(args).toHaveLength(6);
  expect(args).toEqual([
    expected.collection,
    expected.filter,
    expected.sort,
    expected.limit,
    expected.offset,
    expected.params,
  ]);
}

function appWithDraftRows(
  auctionId: string,
  auctionTeams: StubRecord[],
  draftPicks: StubRecord[],
) {
  return {
    findRecordsByFilter(...args: unknown[]) {
      const collection = args[0];
      if (collection === 'auction_teams') {
        assertFindRecordsContract(args, {
          collection: 'auction_teams',
          filter: 'auction_id = {:auctionId}',
          sort: 'draft_order,id',
          limit: 0,
          offset: 0,
          params: { auctionId },
        });
        return auctionTeams;
      }
      if (collection === 'draft_picks') {
        assertFindRecordsContract(args, {
          collection: 'draft_picks',
          filter: 'auction_id = {:auctionId}',
          sort: 'pick_order,created,id',
          limit: 0,
          offset: 0,
          params: { auctionId },
        });
        return draftPicks;
      }
      throw new Error(`Unexpected collection: ${String(collection)}`);
    },
  };
}

function nominationApp(vector: NominationVector, auctionId: string) {
  const auctionTeams = [...vector.teams]
    .sort((a, b) => a.draft_order - b.draft_order)
    .map(team => record({
      id: `auction-team-${team.id}`,
      fantasy_team_id: team.id,
      draft_order: team.draft_order,
      created: `2026-07-17 10:${String(team.draft_order).padStart(2, '0')}:00.000Z`,
    }));
  const draftPicks = vector.picks.map((pick, index) => record({
    id: `pick-${index + 1}`,
    fantasy_team_id: pick.fantasy_team_id,
    price: pick.price,
    pick_order: index + 1,
    created: `2026-07-17 11:${String(index).padStart(2, '0')}:00.000Z`,
  }));

  return appWithDraftRows(auctionId, auctionTeams, draftPicks);
}

function snakeApp(vector: SnakeVector, auctionId: string) {
  const auctionTeams = [...vector.teams]
    .sort((a, b) => a.draft_order - b.draft_order)
    .map(team => record({
      id: `auction-team-${team.id}`,
      fantasy_team_id: team.id,
      draft_order: team.draft_order,
      created: `2026-07-17 10:${String(team.draft_order).padStart(2, '0')}:00.000Z`,
    }));
  const draftPicks = Array.from({ length: vector.totalPicks }, (_, index) => record({
    id: `pick-${index + 1}`,
    pick_order: index + 1,
    created: `2026-07-17 11:${String(index).padStart(2, '0')}:00.000Z`,
  }));

  return appWithDraftRows(auctionId, auctionTeams, draftPicks);
}

function fantasyTeams(...orders: number[]): FantasyTeam[] {
  return orders.map(order => ({
    id: `team-${order}`,
    name: `Team ${order}`,
    draft_order: order,
    created: `2026-07-17 10:${String(order).padStart(2, '0')}:00.000Z`,
    updated: `2026-07-17 10:${String(order).padStart(2, '0')}:00.000Z`,
  }));
}

const standardTeams = fantasyTeams(7, 2, 12, 4, 9, 1, 6, 11, 3, 8, 5, 10);
const configurableTeams = fantasyTeams(3, 1, 4, 2);

// Unpriced picks advance the nomination rotation without filling paid slots.
function unpricedPicks(count: number): NominationVector['picks'] {
  return Array.from({ length: count }, () => ({
    fantasy_team_id: 'team-1',
    price: null,
  }));
}

const nominationVectors: NominationVector[] = [
  ...[1, 11, 12, 23, 24, 167, 168].map(count => ({
    name: `pure snake has no nominator after ${count} picks`,
    teams: standardTeams,
    picks: unpricedPicks(count),
    paidAuctionSlots: 0,
    expected: null,
  })),
  {
    name: 'returns no nominator without auction teams',
    teams: [],
    picks: [],
    paidAuctionSlots: 7,
    expected: null,
  },
  {
    name: 'returns no nominator for a zero slot limit',
    teams: configurableTeams,
    picks: [],
    paidAuctionSlots: 0,
    expected: null,
  },
  {
    name: 'returns no nominator for a negative slot limit',
    teams: configurableTeams,
    picks: [],
    paidAuctionSlots: -1,
    expected: null,
  },
  {
    name: 'starts with the first draft-order team in a standard league',
    teams: standardTeams,
    picks: [],
    paidAuctionSlots: 7,
    expected: 'team-1',
  },
  {
    name: 'ends the first nomination round on the last draft-order team',
    teams: standardTeams,
    picks: unpricedPicks(11),
    paidAuctionSlots: 7,
    expected: 'team-12',
  },
  {
    name: 'snakes back so the last team nominates twice in a row',
    teams: standardTeams,
    picks: unpricedPicks(12),
    paidAuctionSlots: 7,
    expected: 'team-12',
  },
  {
    name: 'runs the second nomination round in reverse draft order',
    teams: standardTeams,
    picks: unpricedPicks(13),
    paidAuctionSlots: 7,
    expected: 'team-11',
  },
  {
    name: 'rotates by nomination order even when another team wins the player',
    teams: configurableTeams,
    picks: [{ fantasy_team_id: 'team-4', price: 31 }],
    paidAuctionSlots: 2,
    expected: 'team-2',
  },
  {
    name: 'zero, negative, and null prices rotate without filling paid slots',
    teams: fantasyTeams(3, 1, 2),
    picks: [
      { fantasy_team_id: 'team-1', price: 0 },
      { fantasy_team_id: 'team-2', price: -4 },
      { fantasy_team_id: 'team-3', price: null },
    ],
    paidAuctionSlots: 1,
    expected: 'team-3',
  },
  {
    name: 'skips a team filled by wins on other teams nominations',
    teams: fantasyTeams(2, 3, 1),
    picks: [
      { fantasy_team_id: 'team-1', price: 20 },
      { fantasy_team_id: 'team-1', price: 18 },
      { fantasy_team_id: 'team-2', price: 12 },
    ],
    paidAuctionSlots: 2,
    expected: 'team-3',
  },
  {
    // The skip scan starts mid-snake on a run of full teams; the only team with
    // open slots sits a full snake period away, past a naive teamCount-wide
    // window. Returning null here would strand the auction with no nominator.
    name: 'finds the one open team when the scan starts on a run of full teams',
    teams: fantasyTeams(3, 1, 2),
    picks: [
      { fantasy_team_id: 'team-1', price: 20 },
      { fantasy_team_id: 'team-1', price: 18 },
      { fantasy_team_id: 'team-2', price: 12 },
      { fantasy_team_id: 'team-2', price: 9 },
    ],
    paidAuctionSlots: 2,
    expected: 'team-3',
  },
  {
    name: 'returns no nominator after every team fills its paid slots',
    teams: fantasyTeams(3, 1, 2),
    picks: [
      { fantasy_team_id: 'team-1', price: 10 },
      { fantasy_team_id: 'team-2', price: 9 },
      { fantasy_team_id: 'team-3', price: 8 },
    ],
    paidAuctionSlots: 1,
    expected: null,
  },
  {
    name: 'stays resolved after all-full history contains extra unpriced rows',
    teams: fantasyTeams(3, 1, 2),
    picks: [
      { fantasy_team_id: 'team-1', price: 10 },
      { fantasy_team_id: 'team-2', price: 9 },
      { fantasy_team_id: 'team-3', price: 8 },
      { fantasy_team_id: 'team-1', price: null },
      { fantasy_team_id: 'team-2', price: 0 },
    ],
    paidAuctionSlots: 1,
    expected: null,
  },
];

// Independent seat sequence covers all 14 pure-snake rounds and both turns.
const pureSnakeOrder = Array.from({ length: 14 }, (_, round) =>
  Array.from({ length: 12 }, (_, seat) => `team-${round % 2 === 0 ? seat + 1 : 12 - seat}`),
).flat();

const snakeVectors: SnakeVector[] = [
  ...pureSnakeOrder.map((team, totalPicks) => ({
    name: `pure snake pick ${totalPicks + 1} of 168`,
    teams: standardTeams,
    totalPicks,
    paidAuctionSlots: 0,
    expectedCurrent: team,
    expectedNext: pureSnakeOrder[totalPicks + 1] ?? 'team-1',
  })),
  {
    name: 'returns no snake team without auction teams',
    teams: [],
    totalPicks: 0,
    paidAuctionSlots: 7,
    expectedCurrent: null,
    expectedNext: null,
  },
  {
    name: 'pure snake starts at the first team before any picks',
    teams: configurableTeams,
    totalPicks: 0,
    paidAuctionSlots: 0,
    expectedCurrent: 'team-1',
    expectedNext: 'team-2',
  },
  {
    name: 'returns no snake team for a negative slot limit',
    teams: configurableTeams,
    totalPicks: 8,
    paidAuctionSlots: -1,
    expectedCurrent: null,
    expectedNext: null,
  },
  {
    name: 'standard league remains in auction mode before pick 85',
    teams: standardTeams,
    totalPicks: 83,
    paidAuctionSlots: 7,
    expectedCurrent: null,
    expectedNext: null,
  },
  {
    name: 'standard league restarts the snake at the first team in draft order',
    teams: standardTeams,
    totalPicks: 84,
    paidAuctionSlots: 7,
    expectedCurrent: 'team-1',
    expectedNext: 'team-2',
  },
  {
    name: 'standard league preserves the forward-to-reverse boundary',
    teams: standardTeams,
    totalPicks: 95,
    paidAuctionSlots: 7,
    expectedCurrent: 'team-12',
    expectedNext: 'team-12',
  },
  {
    name: 'standard league starts its reverse snake round at the last team',
    teams: standardTeams,
    totalPicks: 96,
    paidAuctionSlots: 7,
    expectedCurrent: 'team-12',
    expectedNext: 'team-11',
  },
  {
    name: 'standard league preserves the reverse-to-forward boundary',
    teams: standardTeams,
    totalPicks: 107,
    paidAuctionSlots: 7,
    expectedCurrent: 'team-1',
    expectedNext: 'team-1',
  },
  {
    name: 'configurable league remains in auction mode one pick before transition',
    teams: configurableTeams,
    totalPicks: 7,
    paidAuctionSlots: 2,
    expectedCurrent: null,
    expectedNext: null,
  },
  {
    name: 'configurable league starts after paid slots times actual team count',
    teams: configurableTeams,
    totalPicks: 8,
    paidAuctionSlots: 2,
    expectedCurrent: 'team-1',
    expectedNext: 'team-2',
  },
  {
    name: 'configurable league preserves the forward-to-reverse boundary',
    teams: configurableTeams,
    totalPicks: 11,
    paidAuctionSlots: 2,
    expectedCurrent: 'team-4',
    expectedNext: 'team-4',
  },
  {
    name: 'configurable league starts its reverse snake round',
    teams: configurableTeams,
    totalPicks: 12,
    paidAuctionSlots: 2,
    expectedCurrent: 'team-4',
    expectedNext: 'team-3',
  },
  {
    name: 'configurable league preserves the reverse-to-forward boundary',
    teams: configurableTeams,
    totalPicks: 15,
    paidAuctionSlots: 2,
    expectedCurrent: 'team-1',
    expectedNext: 'team-1',
  },
];

describe('PocketBase hook turn-logic drift guards', () => {
  const hookNominator = extractMarkedFunction<(
    app: ReturnType<typeof nominationApp>,
    auctionId: string,
    slotLimit: number,
  ) => string>(
    nominationHookPath,
    'currentNominatorTeamId',
    'currentNominatorTeamId',
  );
  const hookSnakeTeam = extractMarkedFunction<(
    app: ReturnType<typeof snakeApp>,
    auctionId: string,
    paidAuctionSlots: number,
  ) => string>(
    pickHookPath,
    'calculateCurrentSnakeTeamId',
    'calculateCurrentSnakeTeamId',
  );

  it.each(nominationVectors)('$name', vector => {
    const auctionId = `nomination-${vector.name}`;
    const sharedResult = getNominatorForPick(
      vector.picks.length,
      vector.picks,
      vector.teams,
      vector.paidAuctionSlots,
    );
    const hookResult = hookNominator(
      nominationApp(vector, auctionId),
      auctionId,
      vector.paidAuctionSlots,
    ) || null;

    expect(sharedResult).toBe(vector.expected);
    expect(hookResult).toBe(vector.expected);
  });

  it.each(snakeVectors)('$name', vector => {
    const auctionId = `snake-${vector.name}`;
    const sharedResult = calculateCurrentSnakeTeam(
      vector.teams,
      vector.totalPicks,
      vector.paidAuctionSlots,
    );
    const hookResult = hookSnakeTeam(
      snakeApp(vector, auctionId),
      auctionId,
      vector.paidAuctionSlots,
    ) || null;

    expect(sharedResult.currentTeam?.id ?? null).toBe(vector.expectedCurrent);
    expect(sharedResult.nextTeam?.id ?? null).toBe(vector.expectedNext);
    expect(hookResult).toBe(vector.expectedCurrent);
  });
});
