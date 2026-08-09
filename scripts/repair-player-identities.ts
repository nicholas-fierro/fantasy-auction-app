#!/usr/bin/env -S npx tsx
// Idempotent repair for reviewed player aliases and ID conflicts.
// Dry-run first; applying requires PocketBase superuser credentials.

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import PocketBase, { type RecordModel } from 'pocketbase';

const POCKETBASE_URL = process.env.POCKETBASE_URL || 'http://127.0.0.1:8090';
const ID_FIELDS = ['gsis_id', 'fantasypros_id', 'sleeper_id', 'espn_id'] as const;

const MERGES = [
  ['Kenneth Walker III', 'Ken Walker III', 'RB'],
  ['Hollywood Brown', 'Marquise Brown', 'WR'],
  ['Joshua Palmer', 'Josh Palmer', 'WR'],
  ['Chig Okonkwo', 'Chigoziem Okonkwo', 'TE'],
  ['Kenny Gainwell', 'Kenneth Gainwell', 'RB'],
  ['Gabe Davis', 'Gabriel Davis', 'WR'],
  ["La'Mical Perine", 'Lamical Perine', 'RB'],
  ['Bam Knight', 'Zonovan Knight', 'RB'],
  ['Bisi Johnson', 'Olabisi Johnson', 'WR'],
  ['Scotty Miller', 'Scott Miller', 'WR'],
  ['Dee Eskridge', "D'Wayne Eskridge", 'WR'],
  ['Will Fuller', 'William Fuller V', 'WR'],
  ['Stephen Hauschka', 'Steven Hauschka', 'K'],
  ['Ben Watson', 'Benjamin Watson', 'TE'],
  ['Cordarrelle Patterson', 'Cordarrelle Patterson', 'RB', 'WR'],
  ['Lynn Bowden Jr.', 'Lynn Bowden Jr.', 'WR', 'RB'],
  ['Olamide Zaccheaus', 'Olamide Zaccheaus', 'WR', 'RB'],
  ['Taysom Hill', 'Taysom Hill', 'TE', 'QB'],
  ['Robbie Chosen', 'Robbie Anderson', 'WR'],
  ['Robbie Chosen', 'Robby Anderson', 'WR'],
  ['Mitchell Trubisky', 'Mitch Trubisky', 'QB'],
  ['Deonte Harty', 'Deonte Harris', 'WR'],
  ['Demetric Felton Jr.', 'Demetric Felton', 'RB', 'WR'],
] as const;

// Reviewed against DynastyProcess db_playerids.csv. Position mismatches for
// Russell, Moore, Arcega-Whiteside, and Benjamin are real position changes;
// retain the app's historical position while fixing external IDs.
const OVERRIDES = [
  {
    name: 'Roman Wilson', position: 'WR',
    expected: { sleeper_id: '11630', espn_id: '4431492', fantasypros_id: '28896' },
    set: { gsis_id: '00-0039739', fantasypros_id: '26160' },
  },
  {
    name: 'Tyler Conklin', position: 'TE',
    expected: { sleeper_id: '5133', espn_id: '3122920', fantasypros_id: '17598' },
    set: { gsis_id: '00-0034270', espn_id: '3915486' },
  },
  {
    name: 'Ryan Izzo', position: 'TE',
    expected: { sleeper_id: '5094', espn_id: '3915486' },
    set: { gsis_id: '00-0034439', espn_id: '3122920', fantasypros_id: '17541' },
  },
  {
    name: 'Rondale Moore', position: 'WR',
    expected: { sleeper_id: '7601', espn_id: '4372485' },
    set: { gsis_id: '00-0036936', fantasypros_id: '19796' },
  },
  {
    name: 'J.J. Arcega-Whiteside', position: 'WR',
    expected: { sleeper_id: '5863', espn_id: '3931397' },
    set: { gsis_id: '00-0035246', fantasypros_id: '18235' },
  },
  {
    name: 'Brady Russell', position: 'TE',
    expected: { sleeper_id: '11280', espn_id: '4243176' },
    set: { gsis_id: '00-0038488', fantasypros_id: '25731' },
  },
  {
    name: 'Kelvin Benjamin', position: 'WR',
    expected: { sleeper_id: '2182', espn_id: '16730' },
    set: { gsis_id: '00-0031359', fantasypros_id: '12121' },
  },
  {
    name: 'Phillip Walker', position: 'QB',
    expected: { gsis_id: '', sleeper_id: '', espn_id: '', fantasypros_id: '' },
    set: { gsis_id: '00-0033275', sleeper_id: '4335', espn_id: '3051308', fantasypros_id: '16841' },
  },
  {
    name: "N'Keal Harry", position: 'WR',
    expected: { gsis_id: '', sleeper_id: '', espn_id: '', fantasypros_id: '' },
    set: { gsis_id: '00-0035624', sleeper_id: '5878', espn_id: '4047839', fantasypros_id: '18222' },
  },
  {
    name: 'Devin Funchess', position: 'WR',
    expected: { gsis_id: '', sleeper_id: '', espn_id: '', fantasypros_id: '' },
    set: { gsis_id: '00-0032055', sleeper_id: '2346', espn_id: '2977609', fantasypros_id: '13915' },
  },
  {
    name: 'Jordan Matthews', position: 'WR',
    expected: { gsis_id: '', sleeper_id: '', espn_id: '', fantasypros_id: '' },
    set: { gsis_id: '00-0031299', sleeper_id: '1800', espn_id: '16763', fantasypros_id: '12124' },
  },
  {
    name: 'Andrew Beck', position: 'TE',
    expected: { gsis_id: '', sleeper_id: '', espn_id: '', fantasypros_id: '' },
    set: { gsis_id: '00-0034959', sleeper_id: '6323', espn_id: '3125107', fantasypros_id: '18748' },
  },
  {
    name: 'Lawrence Cager', position: 'WR',
    expected: { gsis_id: '', sleeper_id: '', espn_id: '', fantasypros_id: '' },
    set: { gsis_id: '00-0036145', sleeper_id: '7106', espn_id: '3917849', fantasypros_id: '19701' },
  },
  {
    name: 'Jacob Harris', position: 'TE',
    expected: { gsis_id: '', sleeper_id: '', espn_id: '', fantasypros_id: '' },
    set: { gsis_id: '00-0036918', sleeper_id: '7703', espn_id: '3932144', fantasypros_id: '23251' },
  },
  {
    name: 'Charlie Smyth', position: 'K',
    expected: { sleeper_id: '11653', fantasypros_id: '26444' },
    set: { gsis_id: '00-0039229', espn_id: '5208518' },
  },
  {
    name: 'Carson Beck', position: 'QB',
    expected: { sleeper_id: '13272', fantasypros_id: '22953' },
    set: { gsis_id: 'BEC122142', espn_id: '4430841' },
  },
  {
    name: 'Jacardia Wright', position: 'RB',
    expected: { sleeper_id: '13047', fantasypros_id: '27781' },
    set: { gsis_id: '00-0040067', espn_id: '4428943' },
  },
  {
    name: 'Jakobie Keeney-James', position: 'WR',
    expected: { sleeper_id: '12935', fantasypros_id: '27705' },
    set: { gsis_id: '00-0040388', espn_id: '5178972' },
  },
  {
    name: 'Ben Sauls', position: 'K',
    expected: { sleeper_id: '13066', fantasypros_id: '27798' },
    set: { gsis_id: '00-0040530', espn_id: '4566158' },
  },
] as const;

interface Args { dryRun: boolean; help: boolean }

function parseArgs(argv: string[]): Args {
  const args = { dryRun: false, help: false };
  for (const arg of argv) {
    if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function printHelp(): void {
  console.log(`Usage: npx tsx scripts/repair-player-identities.ts [--dry-run]\n\nMerges reviewed aliases and applies guarded ID corrections.\n`);
}

function value(record: RecordModel, field: string): string {
  return String(record[field] ?? '').trim();
}

async function findPlayer(
  players: RecordModel[],
  name: string,
  position: string,
): Promise<RecordModel | null> {
  const matches = players.filter(
    (player) => value(player, 'name') === name && value(player, 'position') === position,
  );
  if (matches.length > 1) throw new Error(`Multiple ${name} (${position}) records.`);
  return matches[0] ?? null;
}

async function refs(pb: PocketBase, collection: string, playerId: string): Promise<RecordModel[]> {
  return pb.collection(collection).getFullList({
    filter: pb.filter('player_id = {:playerId}', { playerId }),
    requestKey: null,
  });
}

async function planMerge(
  pb: PocketBase,
  players: RecordModel[],
  canonicalName: string,
  aliasName: string,
  canonicalPosition: string,
  aliasPosition = canonicalPosition,
): Promise<{ summary: string; apply: () => Promise<void> } | null> {
  const canonical = await findPlayer(players, canonicalName, canonicalPosition);
  const alias = await findPlayer(players, aliasName, aliasPosition);
  if (!alias) {
    if (!canonical) throw new Error(`Missing both ${canonicalName} and ${aliasName}.`);
    return null;
  }
  if (!canonical) throw new Error(`Missing canonical ${canonicalName} (${canonicalPosition}).`);

  const idUpdate: Record<string, string> = {};
  for (const field of ID_FIELDS) {
    const canonicalId = value(canonical, field);
    const aliasId = value(alias, field);
    if (canonicalId && aliasId && canonicalId !== aliasId) {
      throw new Error(`${canonicalName}/${aliasName} disagree on ${field}.`);
    }
    if (!canonicalId && aliasId) idUpdate[field] = aliasId;
  }

  const [canonicalSeasons, aliasSeasons, picks, watchlist, nominations, logs] = await Promise.all([
    refs(pb, 'player_seasons', canonical.id),
    refs(pb, 'player_seasons', alias.id),
    refs(pb, 'draft_picks', alias.id),
    refs(pb, 'watchlist', alias.id),
    refs(pb, 'auction_nomination_events', alias.id),
    refs(pb, 'player_game_logs', alias.id),
  ]);
  const canonicalByYear = new Map(canonicalSeasons.map((season) => [Number(season.year), season]));
  const seasonMoves: RecordModel[] = [];
  const seasonDeletes: RecordModel[] = [];
  for (const season of aliasSeasons) {
    const existing = canonicalByYear.get(Number(season.year));
    if (!existing) seasonMoves.push(season);
    else if (canonicalName === 'Gabe Davis' && Number(season.year) === 2022) {
      seasonDeletes.push(existing);
      seasonMoves.push(season);
    } else {
      throw new Error(`${canonicalName}/${aliasName} both have season ${season.year}.`);
    }
  }

  const canonicalPicks = await refs(pb, 'draft_picks', canonical.id);
  const canonicalAuctionIds = new Set(canonicalPicks.map((pick) => value(pick, 'auction_id')));
  const duplicatePick = picks.find((pick) => canonicalAuctionIds.has(value(pick, 'auction_id')));
  if (duplicatePick) throw new Error(`${canonicalName}/${aliasName} both appear in auction ${duplicatePick.auction_id}.`);

  const canonicalWatchlist = await refs(pb, 'watchlist', canonical.id);
  const canonicalWatchUsers = new Set(canonicalWatchlist.map((row) => value(row, 'user')));
  const watchDeletes = watchlist.filter((row) => canonicalWatchUsers.has(value(row, 'user')));
  const watchMoves = watchlist.filter((row) => !canonicalWatchUsers.has(value(row, 'user')));

  const canonicalLogs = await refs(pb, 'player_game_logs', canonical.id);
  const canonicalGameIds = new Set(canonicalLogs.map((log) => value(log, 'game_id')));
  const duplicateLog = logs.find((log) => canonicalGameIds.has(value(log, 'game_id')));
  if (duplicateLog) throw new Error(`${canonicalName}/${aliasName} both have game ${duplicateLog.game_id}.`);

  const summary = `${aliasName} -> ${canonicalName}: ${aliasSeasons.length} seasons, ${picks.length} picks, `
    + `${watchlist.length} watchlist, ${nominations.length} nominations, ${logs.length} logs`;

  return {
    summary,
    apply: async () => {
      const batch = pb.createBatch();
      if (Object.keys(idUpdate).length > 0) batch.collection('players').update(canonical.id, idUpdate);
      for (const row of seasonDeletes) batch.collection('player_seasons').delete(row.id);
      for (const row of seasonMoves) batch.collection('player_seasons').update(row.id, { player_id: canonical.id });
      for (const row of picks) batch.collection('draft_picks').update(row.id, { player_id: canonical.id });
      for (const row of watchDeletes) batch.collection('watchlist').delete(row.id);
      for (const row of watchMoves) batch.collection('watchlist').update(row.id, { player_id: canonical.id });
      for (const row of nominations) batch.collection('auction_nomination_events').update(row.id, { player_id: canonical.id });
      for (const row of logs) batch.collection('player_game_logs').update(row.id, { player_id: canonical.id });
      batch.collection('players').delete(alias.id);
      await batch.send();
    },
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return printHelp();
  const email = process.env.PB_SUPERUSER_EMAIL;
  const password = process.env.PB_SUPERUSER_PASSWORD;
  if (!email || !password) throw new Error('Set PB_SUPERUSER_EMAIL and PB_SUPERUSER_PASSWORD.');

  const pb = new PocketBase(POCKETBASE_URL);
  await pb.collection('_superusers').authWithPassword(email, password);
  const players = await pb.collection('players').getFullList({ requestKey: null });
  const plans = [];
  for (const [canonical, alias, canonicalPosition, aliasPosition] of MERGES) {
    const plan = await planMerge(pb, players, canonical, alias, canonicalPosition, aliasPosition);
    if (plan) plans.push(plan);
  }

  console.log(`Alias merges: ${plans.length}`);
  plans.forEach((plan) => console.log(`  ${plan.summary}`));

  const overridePlans: Array<{ record: RecordModel; set: Record<string, string> }> = [];
  for (const override of OVERRIDES) {
    const record = await findPlayer(players, override.name, override.position);
    if (!record) throw new Error(`Missing override target ${override.name}.`);
    const alreadyApplied = Object.entries(override.set).every(([field, expected]) => value(record, field) === expected);
    if (alreadyApplied) continue;
    for (const [field, expected] of Object.entries(override.expected)) {
      if (value(record, field) !== expected) {
        throw new Error(`${override.name}.${field} changed; expected ${expected}, found ${value(record, field)}.`);
      }
    }
    overridePlans.push({ record, set: { ...override.set } });
  }
  console.log(`ID corrections: ${overridePlans.length}`);
  overridePlans.forEach(({ record, set }) => console.log(`  ${record.name}: ${JSON.stringify(set)}`));

  if (args.dryRun) {
    console.log('\n[dry-run] no writes performed.');
    return;
  }
  for (const plan of plans) await plan.apply();
  for (const { record, set } of overridePlans) {
    await pb.collection('players').update(record.id, set, { requestKey: null });
  }
  console.log(`\nApplied ${plans.length} alias merges and ${overridePlans.length} ID corrections.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error) => {
    console.error('Fatal error:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
