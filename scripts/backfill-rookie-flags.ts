#!/usr/bin/env -S npx tsx
// Backfills player_seasons.is_rookie for the historical seasons the rankings
// imports never carried it for (only 2025 arrived with the flag set).
//
// A player's debut season is min(season) over their player_game_logs rows, and a
// season row is a rookie season iff debut === year. nflverse logs only go back to
// 2018 in this instance, so a player whose first log is 2018 is ambiguous (the
// window opens there, not their career) and is left alone — 2018 is skipped.
//
// A player with no logs at all has no derivable answer (a rookie who never saw the
// field, or a future season), so those rows are never touched — the flag only ever
// gets filled in, never cleared on a guess. The hand-entered 2025 flags survive.
//
// A first log in year Y is not enough on its own: a holdout or redshirt season
// (Le'Veon Bell 2019, J.J. McCarthy 2025) also produces one. So the player must
// additionally have no player_seasons row before Y — if they were already ranked or
// drafted in this league, they were not a rookie.
//
// Usage:
//   PB_SUPERUSER_EMAIL=... PB_SUPERUSER_PASSWORD=... \
//     npx tsx scripts/backfill-rookie-flags.ts [--dry-run] [--year 2021]
//
// --dry-run prints the per-year counts and a sample without writing.

import PocketBase from 'pocketbase';

const POCKETBASE_URL = process.env.POCKETBASE_URL || 'http://127.0.0.1:8090';
const WRITE_BATCH_SIZE = 25;
// Earliest season with game logs. A debut in this season can't be distinguished
// from a career that started before the data window, so it is never called rookie.
const LOG_WINDOW_START = 2018;

interface CliArgs {
  dryRun: boolean;
  year: number | null;
}

function parseArgs(argv: string[]): CliArgs {
  let dryRun = false;
  let year: number | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') dryRun = true;
    else if (arg === '--year') year = parseInt(argv[++i] ?? '', 10);
    else throw new Error(`Unknown argument: "${arg}"`);
  }
  if (year !== null && Number.isNaN(year)) throw new Error('--year must be a number');
  return { dryRun, year };
}

// Debut season per player id, from the weekly logs. `fields` keeps the payload to
// two columns over ~51k rows.
async function loadDebutSeasons(pb: PocketBase): Promise<Map<string, number>> {
  const logs = await pb.collection('player_game_logs').getFullList({
    fields: 'player_id,season',
    requestKey: null,
  });
  const debut = new Map<string, number>();
  for (const log of logs) {
    const playerId = log.player_id as string;
    const season = log.season as number;
    const current = debut.get(playerId);
    if (current === undefined || season < current) debut.set(playerId, season);
  }
  return debut;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const pb = new PocketBase(POCKETBASE_URL);
  const email = process.env.PB_SUPERUSER_EMAIL;
  const password = process.env.PB_SUPERUSER_PASSWORD;
  if (!email || !password) {
    throw new Error('PB_SUPERUSER_EMAIL and PB_SUPERUSER_PASSWORD are required');
  }
  await pb.collection('_superusers').authWithPassword(email, password);

  const debut = await loadDebutSeasons(pb);
  console.log(`game logs: debut season known for ${debut.size} players`);

  // Every season row, always — `--year` narrows what gets written, never what the
  // earlier-season guard below can see. Loading only the target year would leave the
  // guard blind to a player's own earlier rows and let it call a returning veteran a
  // rookie, which this script would then write and never clear.
  const allSeasons = await pb.collection('player_seasons').getFullList({
    expand: 'player_id',
    requestKey: null,
  });

  // Earliest season row per player: a player already ranked or drafted in an earlier
  // year cannot be a rookie now, whatever the logs say.
  const firstSeasonYear = new Map<string, number>();
  for (const season of allSeasons) {
    const playerId = season.player_id as string;
    const year = season.year as number;
    const current = firstSeasonYear.get(playerId);
    if (current === undefined || year < current) firstSeasonYear.set(playerId, year);
  }

  const seasons = args.year
    ? allSeasons.filter((season) => season.year === args.year)
    : allSeasons;
  console.log(
    `player_seasons: ${seasons.length} rows${args.year ? ` for ${args.year}` : ''} ` +
      `(${allSeasons.length} loaded for the earlier-season guard)`
  );

  const updates: { id: string; year: number; name: string; next: boolean }[] = [];
  const rookiesByYear = new Map<number, number>();

  for (const season of seasons) {
    const year = season.year as number;
    if (year <= LOG_WINDOW_START) continue;
    const debutSeason = debut.get(season.player_id as string);
    if (debutSeason === undefined) {
      if (season.is_rookie === true) rookiesByYear.set(year, (rookiesByYear.get(year) ?? 0) + 1);
      continue;
    }
    const next =
      debutSeason === year && (firstSeasonYear.get(season.player_id as string) ?? year) >= year;
    if (next) rookiesByYear.set(year, (rookiesByYear.get(year) ?? 0) + 1);
    // Fill in only. An existing `true` is either hand-entered or already correct, and
    // the derivation is not sharp enough to overrule it (a rookie whose logs land under
    // a duplicate identity would otherwise be cleared).
    if (next && season.is_rookie !== true) {
      updates.push({
        id: season.id,
        year,
        name: (season.expand?.player_id?.name as string) ?? season.player_id,
        next,
      });
    }
  }

  console.log('\nrookies per year (after backfill):');
  for (const year of [...rookiesByYear.keys()].sort()) {
    console.log(`  ${year}  ${rookiesByYear.get(year)}`);
  }

  const setTrue = updates.filter((u) => u.next).length;
  console.log(`\nchanges: ${updates.length} rows (${setTrue} -> true, ${updates.length - setTrue} -> false)`);
  for (const u of updates.slice(0, 15)) {
    console.log(`  ${u.year}  ${u.next ? 'rookie ' : 'veteran'}  ${u.name}`);
  }
  if (updates.length > 15) console.log(`  ... and ${updates.length - 15} more`);

  if (args.dryRun) {
    console.log('\n[dry-run] no writes performed');
    return;
  }

  for (let i = 0; i < updates.length; i += WRITE_BATCH_SIZE) {
    await Promise.all(
      updates
        .slice(i, i + WRITE_BATCH_SIZE)
        .map((u) =>
          pb.collection('player_seasons').update(u.id, { is_rookie: u.next }, { requestKey: null })
        )
    );
  }
  console.log(`\nwrote ${updates.length} is_rookie updates (rest unchanged)`);
}

main().catch((error) => {
  console.error('Fatal error:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
