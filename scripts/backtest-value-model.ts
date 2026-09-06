#!/usr/bin/env -S npx tsx
// Walk-forward backtest of the League Value Model, comparing the OLD history
// (priced picks only) against the NEW history ($0 rows synthesized for ranked-
// but-undrafted players — see src/server/lib/value-data.ts). Runnable offline.
//
// For each test year T in 2022–2025: train on official years < T and predict
// every ranked player of year T, then report for both variants:
//   - MAE and mean bias per pick over that year's actually-priced picks (~84);
//   - phantom-positive counts: per position, how many ranked players the model
//     priced > $0 vs how many were actually priced.
// Averages across the four years are printed as an old-vs-new table.
//
// Usage:
//   npx tsx scripts/backtest-value-model.ts --league <league-id> --data <dump.json> [--scoring-format half]
//   PB_SUPERUSER_EMAIL=... PB_SUPERUSER_PASSWORD=... npx tsx scripts/backtest-value-model.ts --league <league-id> [--scoring-format ppr]
// The dump's season rows carry every board; an omitted flag prices the
// league's own board, while an explicit flag asserts against it.

import PocketBase from 'pocketbase';
import { readFileSync } from 'node:fs';
import { isScoringFormat, type ScoringFormat } from '../src/lib/fantasy-scoring';
import { computeAuctionEstimates, type HistoryRow } from '../src/lib/value-model';
import { mapLeagueRecord } from '../src/lib/league';
import { leagueValueModelConfig, loadLeagueHistoryScope } from '../src/lib/league-history';
import {
  buildHistory,
  buildPricedPicks,
  buildTargets,
  loadFromDump,
  loadFromPocketBase,
  toValueTarget,
  type ValueData,
} from '@/server/lib/value-data';

const POCKETBASE_URL = process.env.POCKETBASE_URL || 'http://127.0.0.1:8090';
const TEST_YEARS = [2022, 2023, 2024, 2025];
const POSITIONS = ['QB', 'RB', 'WR', 'TE'];

interface CliArgs {
  leagueId: string;
  data: string | null;
  scoringFormat: ScoringFormat | undefined;
}

// Offline dumps carry league metadata; read the league's own board when the
// flag is omitted, mirroring the live path below (and calc-projected-values).
function dumpLeagueFormat(path: string, leagueId: string): ScoringFormat {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as { leagues?: Array<{ id: string }> };
  const league = raw.leagues?.find((row) => row.id === leagueId);
  if (!league) throw new Error('The dump must include the selected league and fantasy_teams metadata');
  return mapLeagueRecord(league as never).settings.scoringFormat;
}

function parseArgs(argv: string[]): CliArgs {
  let data: string | null = null;
  let leagueId = '';
  let scoringFormat: ScoringFormat | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--data') data = argv[++i] ?? '';
    else if (arg === '--league') leagueId = argv[++i] ?? '';
    else if (arg === '--scoring-format') {
      const value = argv[++i];
      if (!isScoringFormat(value)) throw new Error('--scoring-format must be std, half, or ppr');
      scoringFormat = value;
    } else throw new Error(`Unknown argument: "${arg}"`);
  }
  if (!leagueId.trim() || leagueId.startsWith('--')) throw new Error('--league is required');
  return { data, leagueId, scoringFormat };
}

interface Accuracy {
  n: number;
  mae: number;
  bias: number;
}

// MAE and mean bias (predicted − actual) over a year's actually-priced picks.
function scoreYear(
  data: ValueData,
  year: number,
  history: HistoryRow[]
): { accuracy: Accuracy; predPositiveByPos: Map<string, number> } {
  const targets = buildTargets(data, year);
  const estimates = computeAuctionEstimates(history, targets.map(toValueTarget), year, leagueValueModelConfig(data.scope));
  const keyByPlayer = new Map(targets.map((t) => [t.player_id, t.key]));

  const priced = buildPricedPicks(data, year);
  let absSum = 0;
  let biasSum = 0;
  for (const pick of priced) {
    const key = keyByPlayer.get(pick.player_id);
    const predicted = key ? estimates.get(key) ?? 0 : 0;
    const error = predicted - pick.price;
    absSum += Math.abs(error);
    biasSum += error;
  }
  const n = priced.length;
  const accuracy: Accuracy = {
    n,
    mae: n > 0 ? absSum / n : 0,
    bias: n > 0 ? biasSum / n : 0,
  };

  // Ranked players predicted > $0, per position.
  const predPositiveByPos = new Map<string, number>();
  for (const t of targets) {
    if (t.position_rank <= 0) continue;
    const predicted = estimates.get(t.key) ?? 0;
    if (predicted > 0) predPositiveByPos.set(t.position, (predPositiveByPos.get(t.position) ?? 0) + 1);
  }
  return { accuracy, predPositiveByPos };
}

function pricedCountByPos(data: ValueData, year: number): Map<string, number> {
  const counts = new Map<string, number>();
  for (const pick of buildPricedPicks(data, year)) {
    counts.set(pick.position, (counts.get(pick.position) ?? 0) + 1);
  }
  return counts;
}

function fmt(n: number): string {
  return (n >= 0 ? '+' : '') + n.toFixed(2);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // An omitted --scoring-format prices the league's own board. The format is
  // resolved explicitly here so the loaders always receive a required value —
  // an explicit flag still asserts against the league and aborts on mismatch.
  let data: ValueData;
  if (args.data) {
    const scoringFormat = args.scoringFormat ?? dumpLeagueFormat(args.data, args.leagueId);
    data = loadFromDump(args.data, { leagueId: args.leagueId, scoringFormat });
    console.log(`data: offline dump ${args.data}\n`);
  } else {
    const pb = new PocketBase(POCKETBASE_URL);
    const email = process.env.PB_SUPERUSER_EMAIL;
    const password = process.env.PB_SUPERUSER_PASSWORD;
    if (!email || !password) {
      throw new Error('PB_SUPERUSER_EMAIL and PB_SUPERUSER_PASSWORD are required (or pass --data)');
    }
    await pb.collection('_superusers').authWithPassword(email, password);
    const scoringFormat = args.scoringFormat
      ?? (await loadLeagueHistoryScope(pb, args.leagueId)).settings.scoringFormat;
    data = await loadFromPocketBase(pb, { leagueId: args.leagueId, scoringFormat });
    console.log('data: PocketBase\n');
  }

  const oldAcc: Accuracy[] = [];
  const newAcc: Accuracy[] = [];
  // position -> per-year {oldPred, newPred, priced}
  const phantom = new Map<string, { oldPred: number[]; newPred: number[]; priced: number[] }>();
  for (const pos of POSITIONS) phantom.set(pos, { oldPred: [], newPred: [], priced: [] });

  for (const year of TEST_YEARS) {
    const fullHistory = buildHistory(data, year); // new: priced + $0 undrafted
    const pricedOnly = fullHistory.filter((r) => r.price > 0); // old: priced only

    const oldRes = scoreYear(data, year, pricedOnly);
    const newRes = scoreYear(data, year, fullHistory);
    oldAcc.push(oldRes.accuracy);
    newAcc.push(newRes.accuracy);

    const pricedByPos = pricedCountByPos(data, year);

    console.log(`=== ${year} (train on official years < ${year}) ===`);
    console.log(`  drafted-pick accuracy over ${oldRes.accuracy.n} priced picks:`);
    console.log(`    old (priced-only history):  MAE $${oldRes.accuracy.mae.toFixed(2)}  bias $${fmt(oldRes.accuracy.bias)}`);
    console.log(`    new ($0-augmented history):  MAE $${newRes.accuracy.mae.toFixed(2)}  bias $${fmt(newRes.accuracy.bias)}`);
    console.log(`  phantom positives (ranked players predicted >$0 vs actually priced):`);
    console.log(`    pos   old>$0  new>$0  priced`);
    for (const pos of POSITIONS) {
      const oldP = oldRes.predPositiveByPos.get(pos) ?? 0;
      const newP = newRes.predPositiveByPos.get(pos) ?? 0;
      const pr = pricedByPos.get(pos) ?? 0;
      phantom.get(pos)!.oldPred.push(oldP);
      phantom.get(pos)!.newPred.push(newP);
      phantom.get(pos)!.priced.push(pr);
      console.log(
        `    ${pos.padEnd(4)}  ${String(oldP).padStart(5)}  ${String(newP).padStart(6)}  ${String(pr).padStart(6)}`
      );
    }
    console.log('');
  }

  const avg = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;

  console.log('=== averages 2022–2025 ===');
  console.log('  variant                    MAE     bias');
  console.log(`  old (priced-only)          $${avg(oldAcc.map((a) => a.mae)).toFixed(2)}   $${fmt(avg(oldAcc.map((a) => a.bias)))}`);
  console.log(`  new ($0-augmented)         $${avg(newAcc.map((a) => a.mae)).toFixed(2)}   $${fmt(avg(newAcc.map((a) => a.bias)))}`);

  console.log('\n  phantom positives, averaged per year:');
  console.log('  pos   old>$0  new>$0  priced');
  for (const pos of POSITIONS) {
    const p = phantom.get(pos)!;
    console.log(
      `  ${pos.padEnd(4)}  ${avg(p.oldPred).toFixed(1).padStart(5)}  ${avg(p.newPred).toFixed(1).padStart(6)}  ${avg(p.priced).toFixed(1).padStart(6)}`
    );
  }

  const maeDelta = avg(newAcc.map((a) => a.mae)) - avg(oldAcc.map((a) => a.mae));
  console.log(`\n  drafted-pick MAE change (new − old): $${fmt(maeDelta)} per pick`);
  if (maeDelta > 0.5) {
    console.log('  WARNING: new drafted-pick MAE is more than $0.50 worse than old.');
  }
}

main().catch((error) => {
  console.error('Fatal error:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
