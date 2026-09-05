#!/usr/bin/env -S npx tsx
// Recalculates player_seasons.projected_auction_value for a draft year using
// the League Value Model (src/lib/value-model.ts) — recency-weighted comps
// over this league's own official auction history (now augmented with $0 rows
// for ranked-but-undrafted players), normalized to the $2400 budget.
// Methodology: docs/auction-value-model.md.
//
// This replaces the in-app linear "Calculate Projected Values" tool for years
// where league history exists; running that tool afterwards would overwrite
// these estimates with the linear curve.
//
// Usage:
//   PB_SUPERUSER_EMAIL=... PB_SUPERUSER_PASSWORD=... \
//     npx tsx scripts/calc-projected-values.ts --year 2026 [--dry-run] [--top 40]
//                                              [--scoring-format half]
//                                              [--external-weight 0.5]
//
// Outside-league boards imported by scripts/import-external-auction.ts are
// included by default and discounted by ValueModelConfig.externalWeight.
// --external-weight overrides it; pass 0 to price as if no external board
// existed, which is how to reproduce a pre-import run or check how much of an
// estimate the outside board is responsible for.
//
//   npx tsx scripts/calc-projected-values.ts --year 2026 --dry-run --data <dump.json>
//
// --dry-run prints the would-be top of the board without writing.
// --data reads an offline JSON dump instead of PocketBase (dry-run only, since
// writes need PocketBase).

import PocketBase from 'pocketbase';
import { DEFAULT_VALUE_MODEL_CONFIG, computeAuctionEstimates } from '../src/lib/value-model';
import { isScoringFormat, type ScoringFormat } from '../src/lib/fantasy-scoring';
import {
  buildHistory,
  buildTargets,
  loadFromDump,
  loadFromPocketBase,
  toValueTarget,
  type ValueData,
} from '@/server/lib/value-data';

const POCKETBASE_URL = process.env.POCKETBASE_URL || 'http://127.0.0.1:8090';
const WRITE_BATCH_SIZE = 25;

interface CliArgs {
  year: number;
  dryRun: boolean;
  top: number;
  data: string | null;
  scoringFormat: ScoringFormat;
  externalWeight: number;
}

function parseArgs(argv: string[]): CliArgs {
  let year = 0;
  let dryRun = false;
  let top = 25;
  let data: string | null = null;
  let scoringFormat: ScoringFormat = 'half';
  let externalWeight = DEFAULT_VALUE_MODEL_CONFIG.externalWeight;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') dryRun = true;
    else if (arg === '--external-weight') externalWeight = parseFloat(argv[++i] ?? '');
    else if (arg === '--year') year = parseInt(argv[++i] ?? '', 10);
    else if (arg === '--top') top = parseInt(argv[++i] ?? '', 10);
    else if (arg === '--data') data = argv[++i] ?? '';
    else if (arg === '--scoring-format') {
      const value = argv[++i];
      if (!isScoringFormat(value)) throw new Error('--scoring-format must be std, half, or ppr');
      scoringFormat = value;
    } else throw new Error(`Unknown argument: "${arg}"`);
  }
  if (!year || Number.isNaN(year)) throw new Error('--year is required (e.g. --year 2026)');
  if (data && !dryRun) {
    throw new Error('--data is only allowed with --dry-run (writing values requires PocketBase)');
  }
  if (!Number.isFinite(externalWeight) || externalWeight < 0) {
    throw new Error('--external-weight must be a number >= 0');
  }
  return { year, dryRun, top, data, scoringFormat, externalWeight };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  let pb: PocketBase | null = null;
  let data: ValueData;
  if (args.data) {
    data = loadFromDump(args.data, args.scoringFormat);
    console.log(`data: offline dump ${args.data}`);
  } else {
    pb = new PocketBase(POCKETBASE_URL);
    const email = process.env.PB_SUPERUSER_EMAIL;
    const password = process.env.PB_SUPERUSER_PASSWORD;
    if (!email || !password) {
      throw new Error('PB_SUPERUSER_EMAIL and PB_SUPERUSER_PASSWORD are required');
    }
    await pb.collection('_superusers').authWithPassword(email, password);
    data = await loadFromPocketBase(pb, args.scoringFormat);
  }

  const history = buildHistory(data, args.year);
  const priced = history.filter((r) => r.price > 0).length;
  const undrafted = history.length - priced;
  const historyYears = [...new Set(history.map((r) => r.year))].sort((a, b) => a - b);
  console.log(`history: ${history.length} rows (${priced} priced, ${undrafted} $0 undrafted)`);
  console.log(`history years: ${historyYears.join(', ')}`);
  const externalRows = history.filter((r) => r.external).length;
  if (externalRows > 0) {
    console.log(
      `external: ${externalRows} rows from outside-league boards, weighted ${args.externalWeight}` +
        (args.externalWeight === 0 ? ' (excluded)' : '')
    );
  }

  const targetRows = buildTargets(data, args.year);
  console.log(`targets: ${targetRows.length} ${args.year} season rows`);

  const estimates = computeAuctionEstimates(history, targetRows.map(toValueTarget), args.year, {
    ...DEFAULT_VALUE_MODEL_CONFIG,
    externalWeight: args.externalWeight,
  });

  const board = targetRows
    .map((t) => ({
      id: t.key,
      name: t.name,
      position: t.position,
      rank: t.rank,
      estimate: estimates.get(t.key) ?? 0,
      previous: t.previous,
    }))
    .sort((a, b) => b.estimate - a.estimate);

  const positive = board.filter((b) => b.estimate > 0);
  const top84 = positive.slice(0, 84).reduce((sum, b) => sum + b.estimate, 0);
  console.log(`estimates: ${positive.length} players > $0, top-84 total $${top84}\n`);

  const byPos = new Map<string, number>();
  for (const b of positive) byPos.set(b.position, (byPos.get(b.position) ?? 0) + 1);
  const posSummary = [...byPos.entries()].sort((a, b) => b[1] - a[1]).map(([p, n]) => `${p} ${n}`).join(', ');
  console.log(`positives by position: ${posSummary}\n`);

  console.log(`top ${args.top} (estimate | previous projected):`);
  for (const row of board.slice(0, args.top)) {
    console.log(
      `  ${String(row.estimate).padStart(3)} | ${String(row.previous).padStart(3)}  ` +
        `${row.position.padEnd(3)} #${String(row.rank).padStart(3)}  ${row.name}`
    );
  }

  if (args.dryRun) {
    console.log('\n[dry-run] no writes performed');
    return;
  }

  const updates = board
    .filter((b) => b.estimate !== b.previous)
    .map((b) => ({ id: b.id, value: b.estimate }));
  for (let i = 0; i < updates.length; i += WRITE_BATCH_SIZE) {
    await Promise.all(
      updates.slice(i, i + WRITE_BATCH_SIZE).map((u) =>
        pb!
          .collection('player_seasons')
          .update(u.id, { projected_auction_value: u.value }, { requestKey: null })
      )
    );
  }
  console.log(`\nwrote ${updates.length} projected_auction_value updates (rest unchanged)`);
}

main().catch((error) => {
  console.error('Fatal error:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
