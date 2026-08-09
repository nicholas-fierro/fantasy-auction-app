#!/usr/bin/env -S npx tsx
// Imports nflverse snap counts into player_game_logs.stats, and backfills
// players.birth_date from the roster file the snap join already needs.
// Source data is CC BY 4.0: https://github.com/nflverse/nflverse-data
//
// Snap counts key on pfr_player_id, which this app does not store. The map to
// gsis_id comes from roster_<year>.csv (~92% of skill rows), topped up from the
// DynastyProcess crosswalk that sync-player-ids.ts already caches (~99.7%).
//
// Roughly 14% of skill snap rows have no weekly-stats row: players who were on
// the field and recorded nothing. Those rows are created here with zeroed
// scoring stats, because "played and produced nothing" is the signal the
// touch-based features could not see.
//
// Run after import-nflverse-player-game-logs.ts for the same seasons.
//
// Examples:
//   npx tsx scripts/import-nflverse-snap-counts.ts --year 2024 --dry-run
//   npx tsx scripts/import-nflverse-snap-counts.ts --year 2018,2019,2020

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Papa from 'papaparse';
import PocketBase, { ClientResponseError, RecordModel } from 'pocketbase';
import {
  DISTANCE_LIST_FIELDS,
  NUMERIC_STATS_FIELDS,
  mergeStats,
  type GameLogStats,
} from './import-nflverse-player-game-logs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(SCRIPT_DIR, '.cache');
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const POCKETBASE_URL = process.env.POCKETBASE_URL || 'http://127.0.0.1:8090';

const SNAPS_URL = (year: number) =>
  `https://github.com/nflverse/nflverse-data/releases/download/snap_counts/snap_counts_${year}.csv`;
const ROSTER_URL = (year: number) =>
  `https://github.com/nflverse/nflverse-data/releases/download/rosters/roster_${year}.csv`;
// Same file and cache path sync-player-ids.ts uses, so the download is shared.
const CROSSWALK_URL = 'https://raw.githubusercontent.com/dynastyprocess/data/master/files/db_playerids.csv';
const CROSSWALK_CACHE = join(CACHE_DIR, 'dp-playerids.csv');

// ponytail: skill positions only. Snap share for the fantasy model never needs
// a line or defensive denominator; widen this set if that changes.
const SKILL_POSITIONS = new Set(['QB', 'RB', 'WR', 'TE']);

export const SNAP_STATS_FIELDS = ['offense_snaps', 'offense_pct', 'st_snaps', 'st_pct'] as const;

const SNAP_COLUMNS = [
  'game_id',
  'season',
  'game_type',
  'week',
  'player',
  'pfr_player_id',
  'position',
  'team',
  'opponent',
  ...SNAP_STATS_FIELDS,
] as const;

type CsvRow = Record<string, string | undefined>;

export interface ParsedSnapRow {
  pfrId: string;
  player: string;
  position: string;
  season: number;
  week: number;
  seasonType: 'REG' | 'POST';
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
    if (!Number.isInteger(year) || year < 2012 || year > 2100) {
      throw new Error(`Invalid season "${part}". Expected YYYY (2012-2100; snap counts start in 2012).`);
    }
    return year;
  });
}

function printHelp(): void {
  console.log(`Usage: npx tsx scripts/import-nflverse-snap-counts.ts --year YYYY[,YYYY] [options]

Merges nflverse snap counts into player_game_logs.stats for QB/RB/WR/TE, and
backfills players.birth_date from the same season's roster file. Snap rows with
offensive snaps but no weekly-stats row are created with zeroed scoring stats.
Run import-nflverse-player-game-logs.ts for the same seasons first.

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

// player_game_logs.season_type only has REG and POST; snap counts spell the
// playoff rounds out (WC/DIV/CON/SB).
export function toSeasonType(gameType: string): 'REG' | 'POST' {
  return gameType.trim().toUpperCase() === 'REG' ? 'REG' : 'POST';
}

export function parseSnapRow(row: CsvRow): ParsedSnapRow {
  const stats: GameLogStats = {};
  for (const field of SNAP_STATS_FIELDS) {
    stats[field] = nullableNumber(row[field], field);
  }

  const gameId = (row.game_id ?? '').trim();
  const team = (row.team ?? '').trim();
  const opponent = (row.opponent ?? '').trim();
  if (!gameId || !team || !opponent) {
    throw new Error(`Missing game identity fields for ${gameId || '<unknown game>'}.`);
  }

  return {
    pfrId: (row.pfr_player_id ?? '').trim(),
    player: (row.player ?? '').trim(),
    position: (row.position ?? '').trim().toUpperCase(),
    season: requiredInteger(row.season, 'season'),
    week: requiredInteger(row.week, 'week'),
    seasonType: toSeasonType(row.game_type ?? ''),
    gameId,
    team,
    opponent,
    stats,
  };
}

export function parseSnapCsv(csvText: string, expectedYear: number): ParsedSnapRow[] {
  const parsed = Papa.parse<CsvRow>(csvText, {
    header: true,
    skipEmptyLines: 'greedy',
    transformHeader: (header) => header.trim(),
  });
  if (parsed.errors.length > 0) {
    const first = parsed.errors[0];
    throw new Error(`Unable to parse snap-count CSV at row ${first.row ?? '?'}: ${first.message}`);
  }

  const fields = new Set(parsed.meta.fields ?? []);
  const missing = SNAP_COLUMNS.filter((field) => !fields.has(field));
  if (missing.length > 0) {
    throw new Error(`Snap-count CSV is missing required columns: ${missing.join(', ')}`);
  }

  const rows = parsed.data
    .filter((row) => (row.pfr_player_id ?? '').trim())
    .filter((row) => SKILL_POSITIONS.has((row.position ?? '').trim().toUpperCase()))
    .map(parseSnapRow);
  const wrongYear = rows.find((row) => row.season !== expectedYear);
  if (wrongYear) {
    throw new Error(
      `Expected ${expectedYear} data but found season ${wrongYear.season} in ${wrongYear.gameId}.`,
    );
  }
  return rows;
}

// A weekly-stats row this importer invents for a player who took snaps and
// recorded nothing. Zero, not null: he did play, and he did produce zero.
export function zeroedScoringStats(): GameLogStats {
  const stats: GameLogStats = {};
  for (const field of NUMERIC_STATS_FIELDS) stats[field] = 0;
  for (const field of DISTANCE_LIST_FIELDS) stats[field] = [];
  return stats;
}

async function loadCsv(url: string, cachePath: string, refresh: boolean): Promise<string> {
  if (!refresh && existsSync(cachePath)) {
    const age = Date.now() - statSync(cachePath).mtimeMs;
    if (age < CACHE_MAX_AGE_MS) {
      console.log(`Using cached ${cachePath} (${Math.round(age / 60000)}m old)`);
      return readFileSync(cachePath, 'utf-8');
    }
  }

  console.log(`Fetching ${url} ...`);
  const response = await fetch(url, {
    headers: { 'user-agent': 'fantasy-auction-app nflverse importer' },
  });
  if (!response.ok) {
    throw new Error(`Fetch failed for ${url}: ${response.status} ${response.statusText}`);
  }
  const csvText = await response.text();
  mkdirSync(dirname(cachePath), { recursive: true });
  writeFileSync(cachePath, csvText, 'utf-8');
  return csvText;
}

function parseIdCsv(csvText: string, label: string): CsvRow[] {
  const parsed = Papa.parse<CsvRow>(csvText, {
    header: true,
    skipEmptyLines: 'greedy',
    transformHeader: (header) => header.trim(),
  });
  if (parsed.errors.length > 0) {
    throw new Error(`Unable to parse ${label}: ${parsed.errors[0].message}`);
  }
  return parsed.data;
}

interface IdentitySources {
  gsisByPfrId: Map<string, string>;
  birthDateByGsisId: Map<string, string>;
}

// Both sources spell a missing date "NA". Storing that would be worse than
// storing nothing: the backfill never overwrites, so the junk would block the
// real date forever.
function isoDate(raw: string | undefined): string | null {
  const value = (raw ?? '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

/** Roster files win; the crosswalk only fills pfr_ids the rosters never listed. */
export function buildIdentitySources(rosterRows: CsvRow[], crosswalkRows: CsvRow[]): IdentitySources {
  const gsisByPfrId = new Map<string, string>();
  const birthDateByGsisId = new Map<string, string>();

  for (const row of rosterRows) {
    const gsisId = (row.gsis_id ?? '').trim();
    if (!gsisId) continue;
    const pfrId = (row.pfr_id ?? '').trim();
    if (pfrId) gsisByPfrId.set(pfrId, gsisId);
    const birthDate = isoDate(row.birth_date);
    if (birthDate) birthDateByGsisId.set(gsisId, birthDate);
  }

  for (const row of crosswalkRows) {
    const gsisId = (row.gsis_id ?? '').trim();
    if (!gsisId) continue;

    const pfrId = (row.pfr_id ?? '').trim();
    if (pfrId && !gsisByPfrId.has(pfrId)) gsisByPfrId.set(pfrId, gsisId);

    // Independent of the identity mapping above: a roster row can carry a
    // pfr_id and still leave birth_date blank, and gating this on the mapping
    // would drop a date the crosswalk actually has.
    const birthDate = isoDate(row.birthdate);
    if (birthDate && !birthDateByGsisId.has(gsisId)) birthDateByGsisId.set(gsisId, birthDate);
  }

  return { gsisByPfrId, birthDateByGsisId };
}

async function assertSchema(pb: PocketBase): Promise<void> {
  try {
    const players = await pb.collections.getOne('players');
    const fields = new Set(players.fields.map((field) => field.name));
    const missing = ['gsis_id', 'birth_date'].filter((field) => !fields.has(field));
    if (missing.length > 0) {
      throw new Error(
        `players is missing ${missing.join(', ')}; apply pb_migrations/1784360000_player_birth_date.js first.`,
      );
    }
  } catch (error) {
    if (error instanceof ClientResponseError && error.status === 404) {
      throw new Error('PocketBase is missing the players collection.');
    }
    throw error;
  }

  try {
    await pb.collections.getOne('player_game_logs');
  } catch (error) {
    if (error instanceof ClientResponseError && error.status === 404) {
      throw new Error('PocketBase is missing player_game_logs; import weekly stats first.');
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

  const snapRows: ParsedSnapRow[] = [];
  const rosterRows: CsvRow[] = [];
  for (const year of args.years) {
    const snapCsv = await loadCsv(SNAPS_URL(year), join(CACHE_DIR, `snap_counts_${year}.csv`), args.refresh);
    snapRows.push(...parseSnapCsv(snapCsv, year));
    const rosterCsv = await loadCsv(ROSTER_URL(year), join(CACHE_DIR, `roster_${year}.csv`), args.refresh);
    rosterRows.push(...parseIdCsv(rosterCsv, `roster_${year}.csv`));
  }
  const crosswalkRows = parseIdCsv(
    await loadCsv(CROSSWALK_URL, CROSSWALK_CACHE, args.refresh),
    'db_playerids.csv',
  );
  const { gsisByPfrId, birthDateByGsisId } = buildIdentitySources(rosterRows, crosswalkRows);

  const players = await pb.collection('players').getFullList({ requestKey: null });
  const playersByGsisId = new Map<string, RecordModel>();
  for (const player of players) {
    const gsisId = String(player.gsis_id ?? '').trim();
    if (!gsisId) continue;
    if (playersByGsisId.has(gsisId)) {
      throw new Error(`Duplicate players.gsis_id "${gsisId}"; refusing an ambiguous import.`);
    }
    playersByGsisId.set(gsisId, player);
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
    existingByKey.set(`${String(record.player_id)}:${String(record.game_id)}`, record);
  }

  let unmatchedPfr = 0;
  let unmatchedPlayer = 0;
  let creates = 0;
  let updates = 0;
  let unchanged = 0;
  let skippedNoSnaps = 0;
  const seenKeys = new Set<string>();
  const writes: Array<{ existingId?: string; payload: GameLogPayload }> = [];

  for (const row of snapRows) {
    const gsisId = gsisByPfrId.get(row.pfrId);
    if (!gsisId) {
      unmatchedPfr++;
      continue;
    }
    const player = playersByGsisId.get(gsisId);
    if (!player) {
      unmatchedPlayer++;
      continue;
    }

    const key = `${player.id}:${row.gameId}`;
    if (seenKeys.has(key)) {
      throw new Error(
        `Two snap rows resolve to the same player/game "${row.player} (${row.pfrId}) ${row.gameId}"; fix the pfr_id crosswalk before importing.`,
      );
    }
    seenKeys.add(key);

    const existing = existingByKey.get(key);
    if (!existing && !(Number(row.stats.offense_snaps) > 0)) {
      // Special-teams-only appearance with no weekly-stats row: nothing the
      // fantasy model can use, and inventing a row would distort games played.
      skippedNoSnaps++;
      continue;
    }

    const payload: GameLogPayload = {
      player_id: player.id,
      season: row.season,
      week: row.week,
      season_type: existing ? String(existing.season_type) : row.seasonType,
      game_id: row.gameId,
      team: existing ? String(existing.team) : row.team,
      opponent: existing ? String(existing.opponent) : row.opponent,
      stats: existing
        ? mergeStats(existing.stats, row.stats)
        : { ...zeroedScoringStats(), ...row.stats },
    };

    if (!existing) {
      creates++;
      writes.push({ payload });
    } else if (stableJson(existing.stats) !== stableJson(payload.stats)) {
      updates++;
      writes.push({ existingId: existing.id, payload });
    } else {
      unchanged++;
    }
  }

  const birthDateWrites: Array<{ id: string; birth_date: string }> = [];
  let birthDatesKnown = 0;
  for (const [gsisId, player] of playersByGsisId) {
    if (String(player.birth_date ?? '').trim()) {
      birthDatesKnown++;
      continue;
    }
    const birthDate = birthDateByGsisId.get(gsisId);
    if (birthDate) birthDateWrites.push({ id: player.id, birth_date: birthDate });
  }

  console.log(`\nSnap rows (QB/RB/WR/TE): ${snapRows.length} (${args.years.join(', ')})`);
  console.log(`Unmatched pfr_player_id: ${unmatchedPfr}`);
  console.log(`Matched pfr_id but no local player: ${unmatchedPlayer}`);
  console.log(`Skipped (no offensive snaps, no existing row): ${skippedNoSnaps}`);
  console.log(`Create: ${creates}`);
  console.log(`Update: ${updates}`);
  console.log(`Unchanged: ${unchanged}`);
  console.log(
    `birth_date: ${birthDatesKnown}/${playersByGsisId.size} already set, ${birthDateWrites.length} to backfill`,
  );

  if (args.dryRun) {
    console.log(`\n[dry-run] would write ${writes.length} game logs and ${birthDateWrites.length} birth dates.`);
    return;
  }

  let written = 0;
  for (const write of writes) {
    if (write.existingId) {
      await pb.collection('player_game_logs').update(write.existingId, write.payload, { requestKey: null });
    } else {
      await pb.collection('player_game_logs').create(write.payload, { requestKey: null });
    }
    written++;
  }
  for (const write of birthDateWrites) {
    await pb.collection('players').update(write.id, { birth_date: write.birth_date }, { requestKey: null });
  }
  console.log(`\nWrote ${written} game logs and ${birthDateWrites.length} birth dates.`);
}

const entryPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (entryPath === fileURLToPath(import.meta.url)) {
  void main().catch((error) => {
    console.error('Fatal error:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
