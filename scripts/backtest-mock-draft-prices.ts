#!/usr/bin/env -S npx tsx
// Runs the REAL auction phase (chooseNomination + resolveNomination + computeBase)
// over N independent seeds and compares the resulting price distribution against
// the league's own official drafts.
//
// This is the harness `sim-mock-draft.ts` isn't: that one stubs the auction phase
// with best-available-at-$10 and only checks roster shape. This one exercises the
// pricing path, which is where "Chase Brown goes for $61 in every single mock"
// comes from. Two questions it answers:
//
//   1. Cross-run spread — does the same player clear at different prices in
//      different mock auctions? (sd across runs; zero means the clamp ate the
//      randomness.)
//   2. Calibration — is that spread the size the league's real drafts show?
//      Reported as relative sd by overall-rank bucket, next to the historical
//      figures measured off 2018-2025.
//
// The seed surface of a whole mock draft is exactly one string, the auction id
// (see rng.ts), so a "run" is just a different fake auction id.
//
// Usage:
//   set -a; source .env; set +a
//   npx tsx scripts/backtest-mock-draft-prices.ts [--year 2026] [--runs 25] [--player "Chase Brown"]
import PocketBase from 'pocketbase';
import {
  buildBoard,
  buildHistoryIndexBefore,
  buildProfilesBefore,
  loadLeagueDraftData,
  runDraft,
} from '@/server/lib/mock-draft-data';
import { DEFAULT_ROSTER_SETTINGS } from '@/lib/roster';
import type { Player } from '@/server/types/player';

const pb = new PocketBase(process.env.POCKETBASE_URL || 'http://127.0.0.1:8090');

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const YEAR = Number(arg('year', '2026'));
const RUNS = Number(arg('runs', '25'));
const WATCH = arg('player', 'Chase Brown');

// Same buckets the historical measurement uses, so the two tables line up.
const BUCKETS: [number, number, string][] = [
  [1, 6, '1-6'],
  [7, 12, '7-12'],
  [13, 24, '13-24'],
  [25, 48, '25-48'],
  [49, 84, '49-84'],
  [85, 9999, '85+'],
];
function mean(v: number[]): number {
  return v.reduce((a, b) => a + b, 0) / v.length;
}
function sd(v: number[]): number {
  if (v.length < 2) return 0;
  const m = mean(v);
  return Math.sqrt(mean(v.map((x) => (x - m) ** 2)));
}
function median(v: number[]): number {
  const s = [...v].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
function bucketOf(rank: number): string {
  return BUCKETS.find(([lo, hi]) => rank >= lo && rank <= hi)?.[2] ?? '85+';
}

function historicalRelativeSd(rows: { year: number; rank: number; price: number }[]): Map<string, number> {
  const byYear = new Map<number, typeof rows>();
  for (const row of rows) {
    const list = byYear.get(row.year) ?? [];
    list.push(row);
    byYear.set(row.year, list);
  }

  const residuals = new Map<string, number[]>();
  for (const yearRows of byYear.values()) {
    yearRows.sort((a, b) => a.rank - b.rank);
    for (let i = 0; i < yearRows.length; i++) {
      const neighbors = yearRows
        .slice(Math.max(0, i - 4), i)
        .concat(yearRows.slice(i + 1, i + 5))
        .map((row) => row.price);
      if (neighbors.length < 4) continue;
      const localPrice = median(neighbors);
      if (localPrice <= 0) continue;
      const label = bucketOf(yearRows[i].rank);
      const list = residuals.get(label) ?? [];
      list.push((yearRows[i].price - localPrice) / localPrice);
      residuals.set(label, list);
    }
  }

  return new Map([...residuals].map(([label, values]) => [label, sd(values)]));
}

async function main() {
  await pb
    .collection('_superusers')
    .authWithPassword(process.env.PB_SUPERUSER_EMAIL!, process.env.PB_SUPERUSER_PASSWORD!);

  const data = await loadLeagueDraftData(pb, [YEAR]);
  const { teams, historyRows } = data;
  // No holdout here: this harness asks whether the sim's price SPREAD matches the
  // league's, not whether it predicts a year it has not seen. That is what
  // backtest-mock-draft-behavior.ts is for.
  const profiles = buildProfilesBefore(data, null);
  const index = buildHistoryIndexBefore(data, null);
  const players: Player[] = buildBoard(data, YEAR);
  const officialPrices = data.actual
    .filter((a) => a.price > 0 && a.rank > 0)
    .map((a) => ({ year: a.year, rank: a.rank, price: a.price }));
  const historicalSd = historicalRelativeSd(officialPrices);
  const playersById = new Map(players.map((p) => [p.id, p]));

  console.log(
    `board ${YEAR}: ${players.length} ranked players | ${teams.length} teams | ` +
      `${historyRows.length} history rows | ${RUNS} runs\n`
  );

  const pricesByPlayer = new Map<string, number[]>();
  const runTotals: number[] = [];
  const runTops: number[] = [];
  const runMedians: number[] = [];
  const runMaxRank: number[] = [];

  for (let run = 0; run < RUNS; run++) {
    // Shaped like a real PocketBase id so hashing behaves the same way.
    const auctionId = `backtest${run.toString().padStart(7, '0')}`;
    const sold = runDraft({
      auctionId,
      teams,
      profiles,
      players,
      index,
      year: YEAR,
      settings: DEFAULT_ROSTER_SETTINGS,
      phases: 'auction',
    }).map((pick) => ({ playerId: pick.player_id, price: pick.price ?? 0 }));
    for (const { playerId, price } of sold) {
      const list = pricesByPlayer.get(playerId) ?? [];
      list.push(price);
      pricesByPlayer.set(playerId, list);
    }
    const prices = sold.map((s) => s.price);
    runTotals.push(prices.reduce((a, b) => a + b, 0));
    runTops.push(Math.max(...prices));
    runMedians.push(median(prices));
    runMaxRank.push(Math.max(...sold.map((s) => playersById.get(s.playerId)?.rank ?? 0)));
  }

  // --- Cross-run spread by rank bucket -----------------------------------------
  console.log('cross-run price spread (players sold in >= 3 runs):');
  console.log('bucket    players  meanPrice  mean sd$  rel sd   historical rel sd');
  for (const [, , label] of BUCKETS) {
    const rows = [...pricesByPlayer.entries()]
      .filter(([id, v]) => v.length >= 3 && bucketOf(playersById.get(id)?.rank ?? 9999) === label)
      .map(([, v]) => ({ m: mean(v), s: sd(v) }))
      .filter((r) => r.m > 0);
    if (rows.length === 0) continue;
    const relSd = mean(rows.map((r) => r.s / r.m));
    console.log(
      `${label.padEnd(9)} ${String(rows.length).padStart(7)}  ` +
        `${mean(rows.map((r) => r.m)).toFixed(1).padStart(9)}  ` +
        `${mean(rows.map((r) => r.s)).toFixed(2).padStart(8)}  ` +
        `${relSd.toFixed(3).padStart(6)}   ${(historicalSd.get(label) ?? 0).toFixed(3).padStart(17)}`
    );
  }

  // --- Draft-level invariants ---------------------------------------------------
  console.log('\ndraft-level invariants (target: total 2400, top 82-94, median 18-24):');
  console.log(`  total spend   mean ${mean(runTotals).toFixed(0)}  min ${Math.min(...runTotals)}  max ${Math.max(...runTotals)}`);
  console.log(`  top price     mean ${mean(runTops).toFixed(1)}  min ${Math.min(...runTops)}  max ${Math.max(...runTops)}`);
  console.log(`  median price  mean ${mean(runMedians).toFixed(1)}  min ${Math.min(...runMedians)}  max ${Math.max(...runMedians)}`);
  console.log(`  deepest rank  mean ${mean(runMaxRank).toFixed(0)}  max ${Math.max(...runMaxRank)}`);

  // --- The reported symptom -----------------------------------------------------
  const watched = players.find((p) => p.name?.toLowerCase().includes(WATCH.toLowerCase()));
  if (watched) {
    const v = pricesByPlayer.get(watched.id) ?? [];
    console.log(
      `\n${watched.name} (rank ${watched.rank}, projected $${watched.projected_auction_value ?? '-'}): ` +
        (v.length
          ? `sold in ${v.length}/${RUNS} runs, mean $${mean(v).toFixed(1)}, sd $${sd(v).toFixed(2)}, ` +
            `range $${Math.min(...v)}-$${Math.max(...v)}\n  prices: ${v.join(', ')}`
          : 'never sold')
    );
  }

  // A few most-frequently-sold players, so the spread is visible player by player.
  console.log('\nmost-drafted players:');
  const top = [...pricesByPlayer.entries()]
    .map(([id, v]) => ({ p: playersById.get(id), v }))
    .filter((r) => r.p && r.v.length >= Math.max(3, RUNS * 0.6))
    .sort((a, b) => (a.p!.rank ?? 0) - (b.p!.rank ?? 0))
    .slice(0, 20);
  for (const { p, v } of top) {
    console.log(
      `  ${String(p!.rank).padStart(3)} ${(p!.name ?? '').padEnd(22)} ` +
        `n=${String(v.length).padStart(2)} mean $${mean(v).toFixed(1).padStart(5)} ` +
        `sd $${sd(v).toFixed(2).padStart(5)} range $${Math.min(...v)}-$${Math.max(...v)}`
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
