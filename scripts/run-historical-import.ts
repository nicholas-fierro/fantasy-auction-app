#!/usr/bin/env -S npx tsx
// CLI runner for the historical rankings CSVs (data/historical-rankings/fp-half-ppr-<year>.csv)
// through the app's REAL import logic — `importRankingsCore` in
// src/server/lib/import-core.ts. That function (not a reimplementation of it)
// is what the in-app import UI calls, so name matching, identity creation, and
// the "never clobber projected/actual/is_rookie" guarantees stay identical.
//
// Run with tsx (not in devDependencies; `npx tsx` fetches it on demand):
//   npx tsx scripts/run-historical-import.ts [options]
//
// Uses a plain relative import of import-core.ts (not the `@/` alias) so no
// tsconfig-paths setup is needed for tsx to resolve it.
//
// Prerequisites: a PocketBase instance reachable at POCKETBASE_URL (default
// http://127.0.0.1:8090), plus PB_SUPERUSER_EMAIL and
// PB_SUPERUSER_PASSWORD for API-rule authentication.
//
// Examples:
//   npx tsx scripts/run-historical-import.ts                       # all years found
//   npx tsx scripts/run-historical-import.ts --year 2019
//   npx tsx scripts/run-historical-import.ts --year 2019,2020,2021
//   npx tsx scripts/run-historical-import.ts --year 2020 --file ./custom.csv
//   npx tsx scripts/run-historical-import.ts --help                # no DB connection made

import { readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import PocketBase from 'pocketbase';
import { importRankingsCore } from '../src/server/lib/import-core';
import type { ImportReport } from '../src/server/types/import';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data', 'historical-rankings');
const FILENAME_PATTERN = /^fp-half-ppr-(\d{4})\.csv$/;
const POCKETBASE_URL = process.env.POCKETBASE_URL || 'http://127.0.0.1:8090';

interface CliArgs {
  years: number[] | null; // null = discover every year found in DATA_DIR
  file: string | null;
  help: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const years: number[] = [];
  let file: string | null = null;
  let help = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      help = true;
    } else if (arg === '--year') {
      const value = argv[++i];
      if (!value) throw new Error('--year requires a value');
      for (const part of value.split(',')) {
        const y = parseInt(part.trim(), 10);
        if (Number.isNaN(y)) throw new Error(`Invalid --year value: "${part}"`);
        years.push(y);
      }
    } else if (arg === '--file') {
      const value = argv[++i];
      if (!value) throw new Error('--file requires a value');
      file = value;
    } else {
      throw new Error(`Unknown argument: "${arg}" (see --help)`);
    }
  }

  return { years: years.length > 0 ? years : null, file, help };
}

function printHelp(): void {
  console.log(`Usage: npx tsx scripts/run-historical-import.ts [options]

Imports historical FantasyPros half-PPR rankings CSVs through the app's real
importRankingsCore (src/server/lib/import-core.ts) — the same function the
in-app import UI calls, so matching/identity-creation/never-clobber behavior
is identical to a manual import.

Options:
  --year <y>[,<y>...]   Year(s) to import. Repeatable (--year 2019 --year 2020)
                        or comma-separated (--year 2019,2020). Defaults to
                        every year found in
                        data/historical-rankings/fp-half-ppr-<year>.csv
  --file <path>         Import a single CSV from an explicit path instead of
                        the default data/historical-rankings location.
                        Requires exactly one --year unless the filename
                        itself contains a 4-digit year.
  -h, --help            Show this help and exit. Makes no PocketBase
                        connection and reads no CSV.

Environment:
  POCKETBASE_URL        PocketBase base URL (default http://127.0.0.1:8090)
  PB_SUPERUSER_EMAIL    PocketBase superuser email (required)
  PB_SUPERUSER_PASSWORD PocketBase superuser password (required)

Examples:
  npx tsx scripts/run-historical-import.ts
  npx tsx scripts/run-historical-import.ts --year 2019
  npx tsx scripts/run-historical-import.ts --year 2019,2020,2021
  npx tsx scripts/run-historical-import.ts --year 2020 --file ./custom.csv
`);
}

function discoverYears(): number[] {
  const years: number[] = [];
  for (const entry of readdirSync(DATA_DIR)) {
    const match = entry.match(FILENAME_PATTERN);
    if (match) years.push(parseInt(match[1], 10));
  }
  return years.sort((a, b) => a - b);
}

function yearFromFilename(path: string): number | null {
  const match = basename(path).match(/(\d{4})/);
  return match ? parseInt(match[1], 10) : null;
}

interface YearJob {
  year: number;
  path: string;
}

function buildJobs(args: CliArgs): YearJob[] {
  if (args.file) {
    let year: number;
    if (args.years && args.years.length === 1) {
      year = args.years[0];
    } else if (args.years && args.years.length > 1) {
      throw new Error('--file can only be combined with a single --year');
    } else {
      const inferred = yearFromFilename(args.file);
      if (inferred == null) {
        throw new Error('--file requires --year when the filename has no 4-digit year in it');
      }
      year = inferred;
    }
    return [{ year, path: args.file }];
  }

  const years = (args.years ?? discoverYears()).slice().sort((a, b) => a - b);
  if (years.length === 0) {
    throw new Error(`No historical rankings CSVs found in ${DATA_DIR}`);
  }
  return years.map((year) => ({ year, path: join(DATA_DIR, `fp-half-ppr-${year}.csv`) }));
}

function printReport(year: number, report: ImportReport): void {
  console.log(`\n=== ${year} ===`);
  console.log(
    `created: ${report.created}  updated: ${report.updated}  skipped: ${report.skipped}`
  );

  if (report.fuzzy.length > 0) {
    console.log(`\nFuzzy matches (${report.fuzzy.length}) — csvName matched via normalized name:`);
    console.table(
      report.fuzzy.map((f) => ({
        csvName: f.csvName,
        matchedName: f.matchedName,
        position: f.position,
      }))
    );
  }

  if (report.ambiguous.length > 0) {
    console.log(`\nAmbiguous rows (${report.ambiguous.length}) — skipped, needs manual review:`);
    console.table(
      report.ambiguous.map((a) => ({
        name: a.name,
        team: a.team,
        position: a.position,
        matches: a.matches,
      }))
    );
  }

  if (report.unmatched.length > 0) {
    console.log(`\nUnmatched rows (${report.unmatched.length}):`);
    console.table(report.unmatched);
  }
}

interface SummaryRow {
  year: number;
  status: 'ok' | 'FAILED';
  created: number;
  updated: number;
  skipped: number;
  fuzzy: number;
  ambiguous: number;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    return;
  }

  const jobs = buildJobs(args);
  const pb = new PocketBase(POCKETBASE_URL);
  const email = process.env.PB_SUPERUSER_EMAIL;
  const password = process.env.PB_SUPERUSER_PASSWORD;
  if (!email || !password) {
    throw new Error('PB_SUPERUSER_EMAIL and PB_SUPERUSER_PASSWORD are required (API rules need auth)');
  }
  await pb.collection('_superusers').authWithPassword(email, password);

  const summary: SummaryRow[] = [];
  let hadFailure = false;

  for (const { year, path } of jobs) {
    try {
      const csvText = readFileSync(path, 'utf-8');
      const report = await importRankingsCore(pb, { year, csvText, scoringFormat: 'half' });
      printReport(year, report);
      summary.push({
        year,
        status: 'ok',
        created: report.created,
        updated: report.updated,
        skipped: report.skipped,
        fuzzy: report.fuzzy.length,
        ambiguous: report.ambiguous.length,
      });
    } catch (error) {
      hadFailure = true;
      const message = error instanceof Error ? error.message : String(error);
      console.error(`\n=== ${year} FAILED (${path}) ===`);
      console.error(message);
      summary.push({
        year,
        status: 'FAILED',
        created: 0,
        updated: 0,
        skipped: 0,
        fuzzy: 0,
        ambiguous: 0,
      });
    }
  }

  console.log('\n\n=== Summary (all years) ===');
  console.table(summary);

  if (hadFailure) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('Fatal error:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
