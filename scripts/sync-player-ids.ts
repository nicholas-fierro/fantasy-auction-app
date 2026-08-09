#!/usr/bin/env -S npx tsx
// Reconciles PocketBase player IDs against DynastyProcess's maintained
// crosswalk. Existing IDs are the primary match; only ID-less players may use
// a unique normalized name + position match. Conflicts are reported, never
// overwritten.
//
//   npx tsx scripts/sync-player-ids.ts --dry-run
//   npx tsx scripts/sync-player-ids.ts
//   npx tsx scripts/sync-player-ids.ts --refresh

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Papa from 'papaparse';
import PocketBase, { type RecordModel } from 'pocketbase';
import { normalizeName } from '../src/server/lib/import-core';

export const ID_FIELDS = ['gsis_id', 'fantasypros_id', 'sleeper_id', 'espn_id'] as const;
export type IdField = (typeof ID_FIELDS)[number];

export type PlayerIdentity = {
  id: string;
  name: string;
  position: string;
} & Partial<Record<IdField, unknown>>;

export type CrosswalkIdentity = {
  name?: unknown;
  merge_name?: unknown;
  position?: unknown;
} & Partial<Record<IdField, unknown>>;

export interface PlannedIdUpdate {
  id: string;
  name: string;
  via: 'id' | 'name';
  data: Partial<Record<IdField, string>>;
}

export interface ReconciliationIssue {
  id: string;
  name: string;
  position: string;
  reason: string;
}

export interface DuplicateId {
  scope: 'players' | 'crosswalk' | 'resolution';
  field: IdField | 'identity';
  value: string;
  records: string[];
}

export interface ReconciliationPlan {
  updates: PlannedIdUpdate[];
  conflicts: ReconciliationIssue[];
  unresolved: ReconciliationIssue[];
  duplicates: DuplicateId[];
  coverageBefore: Record<IdField, number>;
  coverageAfter: Record<IdField, number>;
  matchedById: number;
  matchedByName: number;
  unchanged: number;
  skippedDuplicatePlayers: number;
}

interface IndexedCrosswalk {
  index: number;
  row: CrosswalkIdentity;
}

interface ResolvedPlayer {
  player: PlayerIdentity;
  source: IndexedCrosswalk;
  via: 'id' | 'name';
}

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const CACHE_PATH = join(SCRIPT_DIR, '.cache', 'dp-playerids.csv');
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const CROSSWALK_URL = 'https://github.com/DynastyProcess/data/raw/master/files/db_playerids.csv';
const POCKETBASE_URL = process.env.POCKETBASE_URL || 'http://127.0.0.1:8090';

// Reviewed historical/current position transitions in the upstream crosswalk.
// Keep the app's historical display position, but use the source position when
// resolving external IDs so these known records don't stay false conflicts.
const SOURCE_POSITION_OVERRIDES: Record<string, string> = {
  'rondale moore': 'XX',
  'jj arcega-whiteside': 'TE',
  'brady russell': 'RB',
  'kelvin benjamin': 'TE',
  'demetric felton': 'RB',
  "n'keal harry": 'TE',
  'devin funchess': 'TE',
  'jordan matthews': 'TE',
  'andrew beck': 'RB',
  'lawrence cager': 'TE',
  'jacob harris': 'WR',
};

function normalizeId(value: unknown): string | null {
  const id = String(value ?? '').trim();
  return !id || /^(?:0|na|n\/a|null|none)$/i.test(id) ? null : id;
}

function canonicalPosition(value: unknown): string {
  const position = String(value ?? '').trim().toUpperCase();
  if (position === 'FB') return 'RB';
  if (position === 'PK') return 'K';
  return position;
}

function namePositionKey(name: unknown, position: unknown): string {
  const compactName = normalizeName(String(name ?? '')).replace(/[^a-z0-9]/g, '');
  return compactName && canonicalPosition(position)
    ? `${compactName}:${canonicalPosition(position)}`
    : '';
}

function emptyFieldMap<T>(): Record<IdField, T> {
  return Object.fromEntries(ID_FIELDS.map((field) => [field, new Map()])) as Record<IdField, T>;
}

function coverage(
  players: PlayerIdentity[],
  updates: Map<string, PlannedIdUpdate> = new Map(),
): Record<IdField, number> {
  return Object.fromEntries(ID_FIELDS.map((field) => [
    field,
    players.filter((player) => normalizeId(updates.get(player.id)?.data[field] ?? player[field])).length,
  ])) as Record<IdField, number>;
}

function intersectCandidates(candidateLists: IndexedCrosswalk[][]): IndexedCrosswalk[] {
  if (candidateLists.length === 0) return [];
  const remaining = new Set(candidateLists[0].map(({ index }) => index));
  for (const candidates of candidateLists.slice(1)) {
    const indexes = new Set(candidates.map(({ index }) => index));
    for (const index of remaining) {
      if (!indexes.has(index)) remaining.delete(index);
    }
  }
  return candidateLists[0].filter(({ index }) => remaining.has(index));
}

export function planPlayerIdReconciliation(
  players: PlayerIdentity[],
  crosswalk: CrosswalkIdentity[],
): ReconciliationPlan {
  const sourceById = emptyFieldMap<Map<string, IndexedCrosswalk[]>>();
  const playersById = emptyFieldMap<Map<string, PlayerIdentity[]>>();
  const sourceByName = new Map<string, IndexedCrosswalk[]>();

  for (const [index, row] of crosswalk.entries()) {
    const source = { index, row };
    for (const field of ID_FIELDS) {
      const id = normalizeId(row[field]);
      if (!id) continue;
      const matches = sourceById[field].get(id) ?? [];
      matches.push(source);
      sourceById[field].set(id, matches);
    }
    const names = new Set([row.name, row.merge_name].map((name) => namePositionKey(name, row.position)).filter(Boolean));
    for (const key of names) {
      const matches = sourceByName.get(key) ?? [];
      matches.push(source);
      sourceByName.set(key, matches);
    }
  }

  for (const player of players) {
    for (const field of ID_FIELDS) {
      const id = normalizeId(player[field]);
      if (!id) continue;
      const matches = playersById[field].get(id) ?? [];
      matches.push(player);
      playersById[field].set(id, matches);
    }
  }

  const duplicates: DuplicateId[] = [];
  const duplicateSourceIds = new Set<string>();
  const duplicatePlayerIds = new Set<string>();
  for (const field of ID_FIELDS) {
    for (const [value, matches] of sourceById[field]) {
      if (matches.length < 2) continue;
      duplicateSourceIds.add(`${field}:${value}`);
      duplicates.push({
        scope: 'crosswalk',
        field,
        value,
        records: matches.map(({ row }) => `${String(row.name ?? '')} (${canonicalPosition(row.position)})`),
      });
    }
    for (const [value, matches] of playersById[field]) {
      if (matches.length < 2) continue;
      matches.forEach(({ id }) => duplicatePlayerIds.add(id));
      duplicates.push({
        scope: 'players',
        field,
        value,
        records: matches.map((player) => `${player.name} (${player.id})`),
      });
    }
  }

  const conflicts: ReconciliationIssue[] = [];
  const unresolved: ReconciliationIssue[] = [];
  const resolved: ResolvedPlayer[] = [];

  for (const player of players) {
    const position = canonicalPosition(player.position);
    const sourcePosition = SOURCE_POSITION_OVERRIDES[normalizeName(player.name)] ?? position;
    const issue = (reason: string): ReconciliationIssue => ({
      id: player.id,
      name: player.name,
      position,
      reason,
    });
    if (duplicatePlayerIds.has(player.id)) continue;
    if (!position) {
      unresolved.push(issue('missing position'));
      continue;
    }

    const existingIds = ID_FIELDS
      .map((field) => ({ field, value: normalizeId(player[field]) }))
      .filter((entry): entry is { field: IdField; value: string } => entry.value !== null);

    let source: IndexedCrosswalk | undefined;
    let via: 'id' | 'name';
    if (existingIds.length > 0) {
      const candidateLists: IndexedCrosswalk[][] = [];
      const wrongPositions: string[] = [];
      for (const { field, value } of existingIds) {
        const allMatches = sourceById[field].get(value) ?? [];
        const positionMatches = allMatches.filter(({ row }) => canonicalPosition(row.position) === sourcePosition);
        if (allMatches.length > 0 && positionMatches.length === 0) wrongPositions.push(`${field}=${value}`);
        if (positionMatches.length > 0) candidateLists.push(positionMatches);
      }
      if (wrongPositions.length > 0) {
        conflicts.push(issue(`ID position mismatch: ${wrongPositions.join(', ')}`));
        continue;
      }
      if (candidateLists.length === 0) {
        unresolved.push(issue('existing IDs not found in crosswalk'));
        continue;
      }
      const candidates = intersectCandidates(candidateLists);
      if (candidates.length === 0) {
        conflicts.push(issue('existing IDs resolve to different crosswalk rows'));
        continue;
      }
      if (candidates.length > 1) {
        unresolved.push(issue(`existing IDs match ${candidates.length} crosswalk rows`));
        continue;
      }
      [source] = candidates;
      via = 'id';
    } else {
      const candidates = sourceByName.get(namePositionKey(player.name, sourcePosition)) ?? [];
      if (candidates.length === 0) {
        unresolved.push(issue('no unique name + position match'));
        continue;
      }
      if (candidates.length > 1) {
        unresolved.push(issue(`name + position matches ${candidates.length} crosswalk rows`));
        continue;
      }
      [source] = candidates;
      via = 'name';
    }

    const conflictingFields = ID_FIELDS.filter((field) => {
      const current = normalizeId(player[field]);
      const expected = normalizeId(source?.row[field]);
      return current && expected && current !== expected;
    });
    if (conflictingFields.length > 0) {
      conflicts.push(issue(`crosswalk disagrees on ${conflictingFields.join(', ')}`));
      continue;
    }
    resolved.push({ player, source, via });
  }

  const playersBySource = new Map<number, ResolvedPlayer[]>();
  for (const match of resolved) {
    const matches = playersBySource.get(match.source.index) ?? [];
    matches.push(match);
    playersBySource.set(match.source.index, matches);
  }
  const duplicateResolvedPlayers = new Set<string>();
  for (const [sourceIndex, matches] of playersBySource) {
    if (matches.length < 2) continue;
    matches.forEach(({ player }) => duplicateResolvedPlayers.add(player.id));
    duplicates.push({
      scope: 'resolution',
      field: 'identity',
      value: String(crosswalk[sourceIndex]?.name ?? sourceIndex),
      records: matches.map(({ player }) => `${player.name} (${player.id})`),
    });
  }

  const updates: PlannedIdUpdate[] = [];
  let matchedById = 0;
  let matchedByName = 0;
  let unchanged = 0;
  for (const { player, source, via } of resolved) {
    if (duplicateResolvedPlayers.has(player.id)) continue;
    if (via === 'id') matchedById++;
    else matchedByName++;
    const data: Partial<Record<IdField, string>> = {};
    for (const field of ID_FIELDS) {
      const sourceId = normalizeId(source.row[field]);
      if (
        !normalizeId(player[field])
        && sourceId
        && !duplicateSourceIds.has(`${field}:${sourceId}`)
      ) {
        data[field] = sourceId;
      }
    }
    if (Object.keys(data).length > 0) updates.push({ id: player.id, name: player.name, via, data });
    else unchanged++;
  }

  const updatesById = new Map(updates.map((update) => [update.id, update]));
  return {
    updates,
    conflicts,
    unresolved,
    duplicates,
    coverageBefore: coverage(players),
    coverageAfter: coverage(players, updatesById),
    matchedById,
    matchedByName,
    unchanged,
    skippedDuplicatePlayers: new Set([...duplicatePlayerIds, ...duplicateResolvedPlayers]).size,
  };
}

interface CliArgs {
  dryRun: boolean;
  refresh: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { dryRun: false, refresh: false, help: false };
  for (const arg of argv) {
    if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--refresh') args.refresh = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`Unknown argument: "${arg}" (see --help)`);
  }
  return args;
}

function printHelp(): void {
  console.log(`Usage: npx tsx scripts/sync-player-ids.ts [options]

Fill missing players.gsis_id, fantasypros_id, sleeper_id, and espn_id from
DynastyProcess's db_playerids.csv. Existing values are never overwritten.

Options:
  --dry-run   Report planned changes; make no PocketBase writes.
  --refresh   Bypass the 24-hour crosswalk cache.
  -h, --help  Show help; make no network or PocketBase requests.

Environment:
  POCKETBASE_URL         PocketBase URL (default http://127.0.0.1:8090)
  PB_SUPERUSER_EMAIL     PocketBase superuser email
  PB_SUPERUSER_PASSWORD  PocketBase superuser password
  PB_USER_EMAIL          Regular user email (fallback)
  PB_USER_PASSWORD       Regular user password (fallback)
`);
}

async function loadCrosswalk(refresh: boolean): Promise<CrosswalkIdentity[]> {
  let csv: string;
  if (!refresh && existsSync(CACHE_PATH) && Date.now() - statSync(CACHE_PATH).mtimeMs < CACHE_MAX_AGE_MS) {
    console.log(`Using cached DynastyProcess crosswalk: ${CACHE_PATH}`);
    csv = readFileSync(CACHE_PATH, 'utf8');
  } else {
    console.log(`Fetching DynastyProcess crosswalk from ${CROSSWALK_URL} ...`);
    const response = await fetch(CROSSWALK_URL, {
      headers: { 'user-agent': 'fantasy-auction-app player ID sync' },
    });
    if (!response.ok) throw new Error(`Crosswalk fetch failed: ${response.status} ${response.statusText}`);
    csv = await response.text();
    mkdirSync(dirname(CACHE_PATH), { recursive: true });
    writeFileSync(CACHE_PATH, csv, 'utf8');
  }

  const parsed = Papa.parse<CrosswalkIdentity>(csv, { header: true, skipEmptyLines: true });
  if (parsed.errors.length > 0) throw new Error(`Crosswalk parse failed: ${parsed.errors[0].message}`);
  const missingFields = [...ID_FIELDS, 'name', 'position'].filter(
    (field) => !parsed.meta.fields?.includes(field),
  );
  if (missingFields.length > 0) throw new Error(`Crosswalk missing columns: ${missingFields.join(', ')}`);
  return parsed.data;
}

function printPlan(plan: ReconciliationPlan, playerCount: number, sourceCount: number): void {
  console.log(`\nCrosswalk: ${sourceCount} rows`);
  console.log(`Players: ${playerCount}`);
  console.table(ID_FIELDS.map((field) => ({
    field,
    before: plan.coverageBefore[field],
    after: plan.coverageAfter[field],
    added: plan.coverageAfter[field] - plan.coverageBefore[field],
    total: playerCount,
  })));
  console.log(
    `Matched by ID: ${plan.matchedById}; by name + position: ${plan.matchedByName}; `
    + `updates: ${plan.updates.length}; unchanged: ${plan.unchanged}; `
    + `duplicate players skipped: ${plan.skippedDuplicatePlayers}`,
  );

  if (plan.duplicates.length > 0) {
    console.log(`\nDuplicates (${plan.duplicates.length}):`);
    console.table(plan.duplicates.map(({ scope, field, value, records }) => ({
      scope,
      field,
      value,
      records: records.join(' | '),
    })));
  }
  if (plan.conflicts.length > 0) {
    console.log(`\nConflicts (${plan.conflicts.length}, skipped):`);
    console.table(plan.conflicts);
  }
  if (plan.unresolved.length > 0) {
    console.log(`\nUnresolved (${plan.unresolved.length}):`);
    console.table(plan.unresolved);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const pb = new PocketBase(POCKETBASE_URL);
  const superuser = [process.env.PB_SUPERUSER_EMAIL, process.env.PB_SUPERUSER_PASSWORD] as const;
  const user = [process.env.PB_USER_EMAIL, process.env.PB_USER_PASSWORD] as const;
  if (superuser[0] && superuser[1]) {
    await pb.collection('_superusers').authWithPassword(superuser[0], superuser[1]);
  } else if (user[0] && user[1]) {
    await pb.collection('users').authWithPassword(user[0], user[1]);
  } else {
    throw new Error('Set PB_SUPERUSER_EMAIL/PB_SUPERUSER_PASSWORD or PB_USER_EMAIL/PB_USER_PASSWORD');
  }

  const records = await pb.collection('players').getFullList({ requestKey: null });
  if (records.length > 0) {
    const missingFields = ID_FIELDS.filter(
      (field) => !Object.prototype.hasOwnProperty.call(records[0], field),
    );
    if (missingFields.length > 0) {
      throw new Error(`PocketBase players schema missing fields: ${missingFields.join(', ')}`);
    }
  }
  const players: PlayerIdentity[] = (records as RecordModel[]).map((record) => ({
    id: record.id,
    name: String(record.name ?? ''),
    position: String(record.position ?? ''),
    ...Object.fromEntries(ID_FIELDS.map((field) => [field, record[field]])),
  }));
  const crosswalk = await loadCrosswalk(args.refresh);
  const plan = planPlayerIdReconciliation(players, crosswalk);
  printPlan(plan, players.length, crosswalk.length);

  if (args.dryRun) {
    console.log(`\n[dry-run] would write ${plan.updates.length} records; no writes performed`);
    return;
  }
  for (const update of plan.updates) {
    await pb.collection('players').update(update.id, update.data, { requestKey: null });
  }
  console.log(`\nWrote ${plan.updates.length} player updates.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error) => {
    console.error('Fatal error:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
