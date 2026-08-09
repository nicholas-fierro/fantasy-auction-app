#!/usr/bin/env -S npx tsx
// Imports nflverse's public weekly player stats into player_game_logs.
// Source data is CC BY 4.0: https://github.com/nflverse/nflverse-data
//
// Prerequisites:
//   - players.gsis_id exists and is populated
//   - player_game_logs exists with the fields checked by assertSchema()
//   - PocketBase superuser credentials are available in the environment
//
// Examples:
//   npx tsx scripts/import-nflverse-player-game-logs.ts --year 2025 --dry-run
//   npx tsx scripts/import-nflverse-player-game-logs.ts --year 2024,2025
//   npx tsx scripts/import-nflverse-player-game-logs.ts --year 2025 --refresh

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Papa from 'papaparse';
import PocketBase, { ClientResponseError, RecordModel } from 'pocketbase';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(SCRIPT_DIR, '.cache');
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const POCKETBASE_URL = process.env.POCKETBASE_URL || 'http://127.0.0.1:8090';
const SOURCE_URL = (year: number) =>
  `https://github.com/nflverse/nflverse-data/releases/download/stats_player/stats_player_week_${year}.csv`;

const IDENTITY_COLUMNS = [
  'player_id',
  'season',
  'week',
  'season_type',
  'game_id',
  'team',
  'opponent_team',
] as const;

// Raw inputs needed for common STD/HALF/PPR scoring and useful box-score lines.
// Provider fantasy totals are retained only as validation references; consumers
// can derive any reception multiplier from receptions and the raw yard/TD fields.
export const NUMERIC_STATS_FIELDS = [
  'completions',
  'attempts',
  'passing_yards',
  'passing_tds',
  'passing_interceptions',
  'sacks_suffered',
  'sack_yards_lost',
  'sack_fumbles',
  'sack_fumbles_lost',
  'passing_2pt_conversions',
  'carries',
  'rushing_yards',
  'rushing_tds',
  'rushing_fumbles',
  'rushing_fumbles_lost',
  'rushing_2pt_conversions',
  'receptions',
  'targets',
  'receiving_yards',
  'receiving_tds',
  'receiving_fumbles',
  'receiving_fumbles_lost',
  'receiving_2pt_conversions',
  'special_teams_tds',
  'fumble_recovery_tds',
  'fumbles_total',
  'fumbles_lost_total',
  'fg_made',
  'fg_att',
  'fg_missed',
  'fg_blocked',
  'fg_long',
  'fg_made_0_19',
  'fg_made_20_29',
  'fg_made_30_39',
  'fg_made_40_49',
  'fg_made_50_59',
  'fg_made_60_',
  'fg_missed_0_19',
  'fg_missed_20_29',
  'fg_missed_30_39',
  'fg_missed_40_49',
  'fg_missed_50_59',
  'fg_missed_60_',
  'pat_made',
  'pat_att',
  'pat_missed',
  'pat_blocked',
  'fantasy_points',
  'fantasy_points_ppr',
] as const;

export const DISTANCE_LIST_FIELDS = [
  'fg_made_list',
  'fg_missed_list',
  'fg_blocked_list',
] as const;

type NflverseCsvRow = Record<string, string | undefined>;
export type GameLogStats = Record<string, number | number[] | null>;

export interface ParsedGameLog {
  gsisId: string;
  season: number;
  week: number;
  seasonType: string;
  gameId: string;
  team: string;
  opponent: string;
  stats: GameLogStats;
}

interface GameLogPayload {
  player_id: string;
  season: number;
  week: number;
  season_type: string;
  game_id: string;
  team: string;
  opponent: string;
  stats: GameLogStats;
}

interface CliArgs {
  years: number[];
  dryRun: boolean;
  refresh: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { years: [], dryRun: false, refresh: false, help: false };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--refresh') args.refresh = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--year') {
      const value = argv[++i];
      if (!value) throw new Error('--year requires YYYY or a comma-separated list.');
      args.years.push(...parseYears(value));
    } else if (arg.startsWith('--year=')) {
      args.years.push(...parseYears(arg.slice('--year='.length)));
    } else {
      throw new Error(`Unknown argument: "${arg}" (see --help)`);
    }
  }

  args.years = [...new Set(args.years)].sort((a, b) => a - b);
  if (!args.help && args.years.length === 0) {
    throw new Error('--year is required (see --help).');
  }
  return args;
}

function parseYears(value: string): number[] {
  return value.split(',').map((part) => {
    const year = Number(part.trim());
    if (!Number.isInteger(year) || year < 1999 || year > 2100) {
      throw new Error(`Invalid season "${part}". Expected YYYY (1999-2100).`);
    }
    return year;
  });
}

function printHelp(): void {
  console.log(`Usage: npx tsx scripts/import-nflverse-player-game-logs.ts --year YYYY[,YYYY] [options]

Imports nflverse weekly player stats into player_game_logs. Players are matched
only by players.gsis_id; names are never used as a fallback. Existing rows are
updated only when imported fields changed.

Options:
  --year YYYY[,YYYY]  Required season(s) to import.
  --dry-run           Read and report changes without writing.
  --refresh           Bypass the 24h CSV cache.
  -h, --help          Show help; makes no network or DB access.

Environment:
  POCKETBASE_URL          PocketBase URL (default http://127.0.0.1:8090)
  PB_SUPERUSER_EMAIL      PocketBase superuser email
  PB_SUPERUSER_PASSWORD   PocketBase superuser password
`);
}

function nullableNumber(raw: string | undefined, field: string): number | null {
  const value = (raw ?? '').trim();
  if (!value || value === 'NA' || value === 'NaN' || value === 'null') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid ${field} value "${value}".`);
  return parsed;
}

function requiredInteger(raw: string | undefined, field: string): number {
  const value = nullableNumber(raw, field);
  if (value === null || !Number.isInteger(value)) {
    throw new Error(`Missing or non-integer ${field} value "${raw ?? ''}".`);
  }
  return value;
}

function distanceList(raw: string | undefined, field: string): number[] {
  const value = (raw ?? '').trim();
  if (!value || value === 'NA' || value === 'null') return [];
  return value.split(';').map((part) => {
    const distance = Number(part.trim());
    if (!Number.isFinite(distance)) {
      throw new Error(`Invalid ${field} distance "${part}".`);
    }
    return distance;
  });
}

export function parseGameLogRow(row: NflverseCsvRow): ParsedGameLog {
  const stats: GameLogStats = {};
  for (const field of NUMERIC_STATS_FIELDS) {
    stats[field] = nullableNumber(row[field], field);
  }
  for (const field of DISTANCE_LIST_FIELDS) {
    stats[field] = distanceList(row[field], field);
  }

  const season = requiredInteger(row.season, 'season');
  const week = requiredInteger(row.week, 'week');
  const seasonType = (row.season_type ?? '').trim();
  const gameId = (row.game_id ?? '').trim();
  const team = (row.team ?? '').trim();
  const opponent = (row.opponent_team ?? '').trim();
  if (!seasonType || !gameId || !team || !opponent) {
    throw new Error(`Missing game identity fields for ${gameId || '<unknown game>'}.`);
  }

  return {
    gsisId: (row.player_id ?? '').trim(),
    season,
    week,
    seasonType,
    gameId,
    team,
    opponent,
    stats,
  };
}

export function parseNflverseCsv(csvText: string, expectedYear: number): ParsedGameLog[] {
  const parsed = Papa.parse<NflverseCsvRow>(csvText, {
    header: true,
    skipEmptyLines: 'greedy',
    transformHeader: (header) => header.trim(),
  });
  if (parsed.errors.length > 0) {
    const first = parsed.errors[0];
    throw new Error(`Unable to parse nflverse CSV at row ${first.row ?? '?'}: ${first.message}`);
  }

  const fields = new Set(parsed.meta.fields ?? []);
  const required = [...IDENTITY_COLUMNS, ...NUMERIC_STATS_FIELDS, ...DISTANCE_LIST_FIELDS];
  const missing = required.filter((field) => !fields.has(field));
  if (missing.length > 0) {
    throw new Error(`nflverse CSV is missing required columns: ${missing.join(', ')}`);
  }

  // nflverse includes anonymous team aggregate rows in older seasons. They
  // have no player_id and are not player game logs, so ignore them before
  // validating player-level identity fields such as opponent_team.
  const rows = parsed.data
    .filter((row) => (row.player_id ?? '').trim())
    .map(parseGameLogRow);
  const wrongYear = rows.find((row) => row.season !== expectedYear);
  if (wrongYear) {
    throw new Error(
      `Expected ${expectedYear} data but found season ${wrongYear.season} in ${wrongYear.gameId}.`,
    );
  }
  return rows;
}

async function loadCsv(year: number, refresh: boolean): Promise<string> {
  const cachePath = join(CACHE_DIR, `stats_player_week_${year}.csv`);
  if (!refresh && existsSync(cachePath)) {
    const age = Date.now() - statSync(cachePath).mtimeMs;
    if (age < CACHE_MAX_AGE_MS) {
      console.log(`Using cached ${year} stats (${Math.round(age / 60000)}m old): ${cachePath}`);
      return readFileSync(cachePath, 'utf-8');
    }
  }

  const url = SOURCE_URL(year);
  console.log(`Fetching ${url} ...`);
  const response = await fetch(url, {
    headers: { 'user-agent': 'fantasy-auction-app nflverse importer' },
  });
  if (!response.ok) {
    throw new Error(`nflverse ${year} fetch failed: ${response.status} ${response.statusText}`);
  }
  const csvText = await response.text();
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(cachePath, csvText, 'utf-8');
  return csvText;
}

async function assertSchema(pb: PocketBase): Promise<void> {
  try {
    const players = await pb.collections.getOne('players');
    if (!players.fields.some((field) => field.name === 'gsis_id')) {
      throw new Error('PocketBase is missing players.gsis_id; apply the game-log schema migration first.');
    }
  } catch (error) {
    if (error instanceof ClientResponseError && error.status === 404) {
      throw new Error('PocketBase is missing the players collection.');
    }
    throw error;
  }

  try {
    const logs = await pb.collections.getOne('player_game_logs');
    const fields = new Set(logs.fields.map((field) => field.name));
    const required = [
      'player_id',
      'season',
      'week',
      'season_type',
      'game_id',
      'team',
      'opponent',
      'stats',
    ];
    const missing = required.filter((field) => !fields.has(field));
    if (missing.length > 0) {
      throw new Error(`player_game_logs is missing fields: ${missing.join(', ')}.`);
    }
  } catch (error) {
    if (error instanceof ClientResponseError && error.status === 404) {
      throw new Error('PocketBase is missing player_game_logs; apply the game-log schema migration first.');
    }
    throw error;
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

// Other importers (snap counts) add their own keys to the same stats object.
// This importer only owns NUMERIC_STATS_FIELDS and DISTANCE_LIST_FIELDS, so an
// update has to layer its keys over whatever is already stored rather than
// replacing the object and silently dropping the rest.
export function mergeStats(existing: unknown, incoming: GameLogStats): GameLogStats {
  if (!existing || typeof existing !== 'object' || Array.isArray(existing)) return incoming;
  return { ...(existing as GameLogStats), ...incoming };
}

function samePayload(existing: RecordModel, desired: GameLogPayload): boolean {
  return (
    String(existing.player_id ?? '') === desired.player_id &&
    Number(existing.season) === desired.season &&
    Number(existing.week) === desired.week &&
    String(existing.season_type ?? '') === desired.season_type &&
    String(existing.game_id ?? '') === desired.game_id &&
    String(existing.team ?? '') === desired.team &&
    String(existing.opponent ?? '') === desired.opponent &&
    stableJson(existing.stats) === stableJson(desired.stats)
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const email = process.env.PB_SUPERUSER_EMAIL;
  const password = process.env.PB_SUPERUSER_PASSWORD;
  if (!email || !password) {
    throw new Error('Set PB_SUPERUSER_EMAIL and PB_SUPERUSER_PASSWORD.');
  }

  const pb = new PocketBase(POCKETBASE_URL);
  await pb.collection('_superusers').authWithPassword(email, password);
  await assertSchema(pb);

  const players = await pb.collection('players').getFullList({ requestKey: null });
  const playersByGsisId = new Map<string, string>();
  for (const player of players) {
    const gsisId = String(player.gsis_id ?? '').trim();
    if (!gsisId) continue;
    if (playersByGsisId.has(gsisId)) {
      throw new Error(`Duplicate players.gsis_id "${gsisId}"; refusing an ambiguous import.`);
    }
    playersByGsisId.set(gsisId, player.id);
  }

  const sourceRows: ParsedGameLog[] = [];
  for (const year of args.years) {
    sourceRows.push(...parseNflverseCsv(await loadCsv(year, args.refresh), year));
  }

  const filterParams: Record<string, number> = {};
  const filter = args.years
    .map((year, index) => {
      filterParams[`year${index}`] = year;
      return `season = {:year${index}}`;
    })
    .join(' || ');
  const existingRows = await pb.collection('player_game_logs').getFullList({
    filter: pb.filter(filter, filterParams),
    requestKey: null,
  });
  const existingByKey = new Map<string, RecordModel>();
  for (const record of existingRows) {
    const key = `${String(record.player_id)}:${String(record.game_id)}`;
    if (existingByKey.has(key)) {
      throw new Error(`Duplicate player_game_logs key "${key}"; fix the data before importing.`);
    }
    existingByKey.set(key, record);
  }

  let matched = 0;
  let unmatched = 0;
  let creates = 0;
  let updates = 0;
  let unchanged = 0;
  const seenSourceKeys = new Set<string>();
  const writes: Array<{ existingId?: string; payload: GameLogPayload }> = [];

  for (const row of sourceRows) {
    const localPlayerId = playersByGsisId.get(row.gsisId);
    if (!localPlayerId) {
      unmatched++;
      continue;
    }
    matched++;

    const key = `${localPlayerId}:${row.gameId}`;
    if (seenSourceKeys.has(key)) {
      throw new Error(`Duplicate nflverse player/game row "${row.gsisId}:${row.gameId}".`);
    }
    seenSourceKeys.add(key);

    const existing = existingByKey.get(key);
    const payload: GameLogPayload = {
      player_id: localPlayerId,
      season: row.season,
      week: row.week,
      season_type: row.seasonType,
      game_id: row.gameId,
      team: row.team,
      opponent: row.opponent,
      stats: existing ? mergeStats(existing.stats, row.stats) : row.stats,
    };
    if (!existing) {
      creates++;
      writes.push({ payload });
    } else if (!samePayload(existing, payload)) {
      updates++;
      writes.push({ existingId: existing.id, payload });
    } else {
      unchanged++;
    }
  }

  console.log(`\nSource rows: ${sourceRows.length} (${args.years.join(', ')})`);
  console.log(`Matched by gsis_id: ${matched}`);
  console.log(`Unmatched source rows: ${unmatched}`);
  console.log(`Create: ${creates}`);
  console.log(`Update: ${updates}`);
  console.log(`Unchanged: ${unchanged}`);

  if (args.dryRun) {
    console.log(`\n[dry-run] would write ${writes.length} rows; no writes performed.`);
    return;
  }

  let written = 0;
  for (const write of writes) {
    if (write.existingId) {
      await pb.collection('player_game_logs').update(write.existingId, write.payload, {
        requestKey: null,
      });
    } else {
      await pb.collection('player_game_logs').create(write.payload, { requestKey: null });
    }
    written++;
  }
  console.log(`\nWrote ${written} rows.`);
}

const entryPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (entryPath === fileURLToPath(import.meta.url)) {
  void main().catch((error) => {
    console.error('Fatal error:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
