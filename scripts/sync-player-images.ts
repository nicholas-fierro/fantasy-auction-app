#!/usr/bin/env -S npx tsx
// Backfills players.sleeper_id / players.espn_id (pb_migrations/1784120000_player_images.js)
// by matching every app player against Sleeper's public player dump
// (https://api.sleeper.app/v1/players/nfl). These IDs are used to build
// headshot CDN URLs client-side:
//   sleeper_id -> https://sleepercdn.com/content/nfl/players/{id}.jpg
//   espn_id    -> ESPN's combiner headshot CDN
//
// Run with tsx (not in devDependencies; `npx tsx` fetches it on demand):
//   PB_SUPERUSER_EMAIL=... PB_SUPERUSER_PASSWORD=... \
//     npx tsx scripts/sync-player-images.ts [options]
//
// Uses a plain relative import of import-core.ts (not the `@/` alias) so no
// tsconfig-paths setup is needed for tsx to resolve it. Only `normalizeName`
// is reused from there — the app-side name normalization must match what the
// rest of the import pipeline uses.
//
// Matching: Sleeper's dump has no spaces/punctuation in `search_full_name`
// (e.g. "Ja'Marr Chase" -> "jamarrchase"), so the app name is run through
// normalizeName() (lowercase, strip periods, drop Jr/Sr/II/III suffixes) and
// then stripped of everything but [a-z0-9] before lookup. Candidates are
// narrowed by position; if more than one remains, the player's latest known
// team (from player_seasons, newest year first) is used as a tiebreaker, then
// `active: true`. Still ambiguous -> reported and skipped, never guessed.
//
// Prerequisites: a PocketBase instance reachable at POCKETBASE_URL (default
// http://127.0.0.1:8090). players' API rules require auth for writes, so a
// superuser login is used (same pattern as scripts/calc-projected-values.ts).
//
// The Sleeper dump (~14MB) is cached to scripts/.cache/sleeper-players.json
// and reused if less than 24h old; --refresh forces a re-download.
//
// Examples:
//   npx tsx scripts/sync-player-images.ts --dry-run
//   npx tsx scripts/sync-player-images.ts
//   npx tsx scripts/sync-player-images.ts --force
//   npx tsx scripts/sync-player-images.ts --refresh
//   npx tsx scripts/sync-player-images.ts --help          # no network/DB access

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import PocketBase from 'pocketbase';
import {
  DP_IDS_URL as SHARED_DP_IDS_URL,
  SLEEPER_DUMP_URL as SHARED_SLEEPER_DUMP_URL,
  buildSleeperIndex,
  loadLatestTeamByPlayer,
  matchSleeperIds,
  parseDpEspnMap,
  type SleeperDump,
} from '@/server/lib/player-ids';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(__dirname, '.cache');
const CACHE_PATH = join(CACHE_DIR, 'sleeper-players.json');
const DP_CACHE_PATH = join(CACHE_DIR, 'dp-playerids.csv');
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h
const SLEEPER_DUMP_URL = SHARED_SLEEPER_DUMP_URL;
const DP_IDS_URL = SHARED_DP_IDS_URL;
const POCKETBASE_URL = process.env.POCKETBASE_URL || 'http://127.0.0.1:8090';

// Position folding, name aliases, index building, and the match rules live in
// src/server/lib/player-ids.ts, shared with the in-app "Sync player IDs"
// action so both map players identically. This script keeps the disk cache,
// the CLI flags, and the console reporting.

interface CliArgs {
  dryRun: boolean;
  force: boolean;
  refresh: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { dryRun: false, force: false, refresh: false, help: false };
  for (const arg of argv) {
    if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--force') args.force = true;
    else if (arg === '--refresh') args.refresh = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`Unknown argument: "${arg}" (see --help)`);
  }
  return args;
}

function printHelp(): void {
  console.log(`Usage: npx tsx scripts/sync-player-images.ts [options]

Backfills players.sleeper_id / players.espn_id by matching app players
against Sleeper's public player dump (https://api.sleeper.app/v1/players/nfl).

Options:
  --dry-run   Report what would change; make no writes.
  --force     Re-match players that already have a sleeper_id.
  --refresh   Bypass the 24h dump cache and re-download from Sleeper.
  -h, --help  Show this help and exit. Makes no network or DB access.

Environment:
  POCKETBASE_URL         PocketBase base URL (default http://127.0.0.1:8090)
  PB_SUPERUSER_EMAIL     Superuser email (players writes only need an authed
  PB_SUPERUSER_PASSWORD  request, so regular user creds below also work)
  PB_USER_EMAIL          Regular user email (used when superuser vars unset)
  PB_USER_PASSWORD       Regular user password

Examples:
  npx tsx scripts/sync-player-images.ts --dry-run
  npx tsx scripts/sync-player-images.ts
  npx tsx scripts/sync-player-images.ts --force
  npx tsx scripts/sync-player-images.ts --refresh
`);
}

async function loadSleeperDump(refresh: boolean): Promise<SleeperDump> {
  if (!refresh && existsSync(CACHE_PATH)) {
    const age = Date.now() - statSync(CACHE_PATH).mtimeMs;
    if (age < CACHE_MAX_AGE_MS) {
      console.log(`Using cached Sleeper dump (${Math.round(age / 60000)}m old): ${CACHE_PATH}`);
      return JSON.parse(readFileSync(CACHE_PATH, 'utf-8')) as SleeperDump;
    }
  }

  console.log(`Fetching Sleeper player dump from ${SLEEPER_DUMP_URL} ...`);
  const res = await fetch(SLEEPER_DUMP_URL);
  if (!res.ok) {
    throw new Error(`Sleeper dump fetch failed: ${res.status} ${res.statusText}`);
  }
  const text = await res.text();

  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(CACHE_PATH, text, 'utf-8');
  console.log(`Cached Sleeper dump to ${CACHE_PATH}`);

  return JSON.parse(text) as SleeperDump;
}

// sleeper_id -> espn_id from the DynastyProcess ID map. Cached like the
// Sleeper dump; --refresh forces a re-download.
async function loadDpEspnBySleeperId(refresh: boolean): Promise<Map<string, string>> {
  let csvText: string;
  if (!refresh && existsSync(DP_CACHE_PATH) && Date.now() - statSync(DP_CACHE_PATH).mtimeMs < CACHE_MAX_AGE_MS) {
    console.log(`Using cached DynastyProcess ID map: ${DP_CACHE_PATH}`);
    csvText = readFileSync(DP_CACHE_PATH, 'utf-8');
  } else {
    console.log(`Fetching DynastyProcess ID map from ${DP_IDS_URL} ...`);
    const res = await fetch(DP_IDS_URL);
    if (!res.ok) {
      throw new Error(`DynastyProcess ID map fetch failed: ${res.status} ${res.statusText}`);
    }
    csvText = await res.text();
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(DP_CACHE_PATH, csvText, 'utf-8');
  }

  const map = parseDpEspnMap(csvText);
  console.log(`DynastyProcess ID map: ${map.size} sleeper->espn mappings`);
  return map;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    return;
  }

  const pb = new PocketBase(POCKETBASE_URL);
  // The players update rule only requires an authenticated request
  // (@request.auth.id != ""), so a regular user account works; superuser
  // creds are also accepted for parity with the other scripts.
  const superEmail = process.env.PB_SUPERUSER_EMAIL;
  const superPassword = process.env.PB_SUPERUSER_PASSWORD;
  const userEmail = process.env.PB_USER_EMAIL;
  const userPassword = process.env.PB_USER_PASSWORD;
  if (superEmail && superPassword) {
    await pb.collection('_superusers').authWithPassword(superEmail, superPassword);
  } else if (userEmail && userPassword) {
    await pb.collection('users').authWithPassword(userEmail, userPassword);
  } else {
    throw new Error('Set PB_SUPERUSER_EMAIL/PB_SUPERUSER_PASSWORD or PB_USER_EMAIL/PB_USER_PASSWORD');
  }

  const dump = await loadSleeperDump(args.refresh);
  const dpEspnBySleeperId = await loadDpEspnBySleeperId(args.refresh);
  const sleeperIndex = buildSleeperIndex(dump);
  console.log(`Sleeper dump: ${Object.keys(dump).length} entries, ${sleeperIndex.size} distinct search keys (matchable positions only)`);

  const players = await pb.collection('players').getFullList({ requestKey: null });
  const latestTeamByPlayer = await loadLatestTeamByPlayer(pb);

  const result = matchSleeperIds(
    players,
    sleeperIndex,
    latestTeamByPlayer,
    dpEspnBySleeperId,
    args.force
  );

  console.log(`\nApp players: ${players.length}`);
  console.log(`  skipped (DST): ${result.skippedDst}`);
  console.log(`  already had sleeper_id (skipped, use --force to re-match): ${result.alreadyHadId}`);
  console.log(`  matched: ${result.matches.length} (of which ${result.teamTiebreaks} via team tiebreak)`);
  console.log(`  espn_id backfilled from DynastyProcess map: ${result.espnBackfills.length}`);
  console.log(`  ambiguous: ${result.ambiguous.length}`);
  console.log(`  unmatched: ${result.unmatched.length}`);

  if (result.ambiguous.length > 0) {
    console.log(`\nAmbiguous (skipped, needs manual review):`);
    console.table(result.ambiguous);
  }
  if (result.unmatched.length > 0) {
    console.log(`\nUnmatched:`);
    console.table(result.unmatched);
  }

  const allWrites = [...result.matches, ...result.espnBackfills];

  if (args.dryRun) {
    console.log(`\n[dry-run] would write ${allWrites.length} updates; no writes performed`);
    return;
  }

  let written = 0;
  for (const update of allWrites) {
    await pb.collection('players').update(
      update.id,
      { sleeper_id: update.sleeperId, espn_id: update.espnId },
      { requestKey: null }
    );
    written++;
  }
  console.log(`\nwrote ${written} player updates`);
}

main().catch((error) => {
  console.error('Fatal error:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
