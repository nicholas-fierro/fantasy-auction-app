#!/usr/bin/env -S npx tsx
// Leave-one-year-out backtest of the mock draft's BEHAVIOR, not just its prices.
//
// For each holdout year Y the team profiles and the comp index are built from the
// years before Y only, the sim drafts year Y's real board, and the result is scored
// against what the league actually did that year.
//
// The question this answers is the one that decides whether calibration is worth
// doing at all: does the per-manager profile layer beat a league of twelve
// identical average managers? Three arms run side by side —
//
//   fitted    profiles from the years before Y
//   neutral   every team gets NEUTRAL_PROFILE      <- if fitted ties this, the
//                                                     profile mechanism earns nothing
//   shuffled  real profiles moved to the wrong team ids, i.e. the right amount of
//             between-manager variety attached to the wrong people
//
// plus two static reference columns that need no sim run: `chance` (1/12 for
// assignment; the league-mean share vector for positional share, which is the limit
// shrinkage converges to) and the league's own price noise floor.
//
// 2018 has no ranked player_seasons, so 2019 has no usable prior year: the holdout
// range starts at 2020.
//
// Usage:
//   set -a; source .env; set +a
//   npx tsx scripts/backtest-mock-draft-behavior.ts [--seeds 20] [--years 2020-2025]
//     [--arms fitted,neutral,shuffled] [--batches 3] [--json out.json]
import PocketBase from 'pocketbase';
import { writeFileSync } from 'node:fs';
import {
  buildBoard,
  buildHistoryIndexBefore,
  buildProfilesBefore,
  loadLeagueDraftData,
  neutralProfiles,
  runDraft,
  settingsForYear,
  shuffledProfiles,
  type LeagueDraftData,
} from '@/server/lib/mock-draft-data';
import {
  BUCKETS,
  bucketOf,
  mean,
  median,
  scoreDraft,
  SCORE_POSITIONS,
  toScoredPicks,
  type Scorecard,
  type ScoredPick,
} from '@/server/lib/mock-draft-score';
import type { TeamProfile } from '@/lib/mock-draft/types';

const pb = new PocketBase(process.env.POCKETBASE_URL || 'http://127.0.0.1:8090');

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const SEEDS = Number(arg('seeds', '20'));
const BATCHES = Number(arg('batches', '1'));
const JSON_OUT = arg('json', '');
const [YEAR_FROM, YEAR_TO] = arg('years', '2020-2025').split('-').map(Number);
const ARMS = arg('arms', 'fitted,neutral,shuffled').split(',') as ArmName[];

type ArmName = 'fitted' | 'neutral' | 'shuffled';

// --- the league's own price noise floor --------------------------------------

// Within-year price residual against a local rank curve, in dollars per bucket.
// No model can be more accurate than this; it is the denominator that makes a
// price MAE readable.
function noiseFloor(rows: { year: number; rank: number; price: number }[]): {
  byBucket: Map<string, number>;
  overall: number;
} {
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
      // Absolute residual in dollars: the MAE an oracle rank curve would still make.
      list.push(Math.abs(yearRows[i].price - localPrice));
      residuals.set(label, list);
    }
  }

  const byBucket = new Map([...residuals].map(([label, v]) => [label, mean(v)]));
  const all = [...residuals.values()].flat();
  return { byBucket, overall: mean(all) };
}

// --- the chance baselines ----------------------------------------------------

// What a predictor that hands every manager the league-mean share vector scores.
// Shrinkage converges to exactly this, so it is the number the profile layer has
// to beat to be doing anything at all.
function leagueMeanShareMae(actual: ScoredPick[], teamIds: string[]): number {
  const shares = new Map<string, Record<string, number>>();
  for (const teamId of teamIds) {
    const mine = actual.filter((p) => p.teamId === teamId && p.price > 0);
    const total = mine.reduce((a, b) => a + b.price, 0);
    const row: Record<string, number> = {};
    for (const pos of SCORE_POSITIONS) {
      row[pos] = total > 0
        ? mine.filter((p) => p.position === pos).reduce((a, b) => a + b.price, 0) / total
        : 0;
    }
    shares.set(teamId, row);
  }
  const errors: number[] = [];
  for (const pos of SCORE_POSITIONS) {
    const values = teamIds.map((id) => shares.get(id)?.[pos] ?? 0);
    const leagueMean = mean(values);
    for (const value of values) errors.push(Math.abs(value - leagueMean));
  }
  return mean(errors);
}

// --- one arm, one year -------------------------------------------------------

function runArm(
  data: LeagueDraftData,
  year: number,
  profiles: Map<string, TeamProfile>,
  seedOffset: number
): Scorecard {
  const index = buildHistoryIndexBefore(data, year);
  const board = buildBoard(data, year);
  const settings = settingsForYear(year);
  const runs: ScoredPick[][] = [];

  for (let seed = 0; seed < SEEDS; seed++) {
    const auctionId = `hold${year}-${String(seedOffset + seed).padStart(3, '0')}`;
    const picks = runDraft({
      auctionId,
      teams: data.teams,
      profiles,
      players: board,
      index,
      year,
      settings,
      phases: 'both',
    });
    runs.push(toScoredPicks(picks, board));
  }

  const actual: ScoredPick[] = data.actual
    .filter((a) => a.year === year)
    .map((a) => ({
      teamId: a.teamId,
      playerId: a.playerId,
      price: a.price,
      position: a.position,
      rank: a.rank,
    }));

  return scoreDraft(actual, runs, data.teams, year);
}

// --- report ------------------------------------------------------------------

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

function row(label: string, cells: string[]): string {
  return `${label.padEnd(26)}${cells.map((c) => c.padStart(12)).join('')}`;
}

function summarize(cards: Scorecard[]): Record<string, number> {
  return {
    coverage: mean(cards.map((c) => c.coverage)),
    softAssign: mean(cards.map((c) => c.softAssign)),
    softAssignConditional: mean(cards.map((c) => c.softAssignConditional)),
    priceMae: mean(cards.map((c) => c.priceMae)),
    priceSignedError: mean(cards.map((c) => c.priceSignedError)),
    sortedCurveMae: mean(cards.map((c) => c.sortedCurveMae)),
    posShareMae: mean(cards.map((c) => c.posShareMae)),
    posShareCorr: mean(cards.map((c) => c.posShareCorr)),
    concentrationMae: mean(cards.map((c) => c.concentrationMae)),
    concentrationCorr: mean(cards.map((c) => c.concentrationCorr)),
    topPrice: mean(cards.map((c) => c.topPrice)),
    medianPrice: mean(cards.map((c) => c.medianPrice)),
    gini: mean(cards.map((c) => c.gini)),
    deepestRank: mean(cards.map((c) => c.deepestRank)),
    snakePosShareMae: mean(cards.map((c) => c.snakePosShareMae)),
    snakePosShareCorr: mean(cards.map((c) => c.snakePosShareCorr)),
    snakeSoftAssign: mean(cards.map((c) => c.snakeSoftAssign)),
    snakeRosterL1: mean(cards.map((c) => c.snakeRosterL1)),
  };
}

async function main() {
  await pb
    .collection('_superusers')
    .authWithPassword(process.env.PB_SUPERUSER_EMAIL!, process.env.PB_SUPERUSER_PASSWORD!);

  const data = await loadLeagueDraftData(pb);
  // Completed drafts only — a year still being drafted is not something to score
  // the sim against.
  const years: number[] = [];
  for (let y = YEAR_FROM; y <= YEAR_TO; y++) {
    if (data.completedYears.includes(y)) years.push(y);
  }

  const floor = noiseFloor(
    data.actual.filter((a) => a.price > 0 && a.rank > 0).map((a) => ({ year: a.year, rank: a.rank, price: a.price }))
  );

  console.log(
    `holdout years ${years.join(', ')} | ${SEEDS} seeds x ${BATCHES} batch(es) | ` +
      `${data.teams.length} teams | ${data.actual.length} historical picks\n`
  );

  // Profile sample size per holdout year, so a thin fold is visible rather than
  // silently dragging the average down.
  console.log('profile evidence available to each holdout year:');
  for (const year of years) {
    const profiles = buildProfilesBefore(data, year);
    const sizes = [...profiles.values()].map((p) => p.sampleSize);
    console.log(
      `  ${year}   priced picks per team: min ${Math.min(...sizes)}  median ${median(sizes)}  max ${Math.max(...sizes)}`
    );
  }

  const byArm = new Map<ArmName, Scorecard[][]>();
  for (const armName of ARMS) byArm.set(armName, []);

  for (let batch = 0; batch < BATCHES; batch++) {
    for (const armName of ARMS) {
      const cards: Scorecard[] = [];
      for (const year of years) {
        const fitted = buildProfilesBefore(data, year);
        const profiles =
          armName === 'fitted'
            ? fitted
            : armName === 'neutral'
              ? neutralProfiles(data)
              : shuffledProfiles(fitted, data.teams);
        cards.push(runArm(data, year, profiles, batch * SEEDS));
      }
      byArm.get(armName)!.push(cards);
    }
  }

  // --- headline table ---------------------------------------------------------
  const summaries = new Map<ArmName, Record<string, number>>();
  for (const armName of ARMS) {
    summaries.set(armName, summarize(byArm.get(armName)![0]));
  }

  const chanceAssign = 1 / 12;
  const chanceShareMae = mean(
    years.map((year) =>
      leagueMeanShareMae(
        data.actual
          .filter((a) => a.year === year)
          .map((a) => ({
            teamId: a.teamId,
            playerId: a.playerId,
            price: a.price,
            position: a.position,
            rank: a.rank,
          })),
        data.teams.map((t) => t.id)
      )
    )
  );

  console.log(`\n${row('metric', [...ARMS, 'chance/floor'])}`);
  const get = (name: ArmName, key: string) => summaries.get(name)![key];

  console.log(
    row('soft assign accuracy', [
      ...ARMS.map((a) => pct(get(a, 'softAssign'))),
      pct(chanceAssign),
    ])
  );
  console.log(
    row('  ...conditional', [...ARMS.map((a) => pct(get(a, 'softAssignConditional'))), pct(chanceAssign)])
  );
  console.log(row('board overlap (recall@84)', [...ARMS.map((a) => pct(get(a, 'coverage'))), '-']));
  console.log(
    row('pos share MAE', [...ARMS.map((a) => get(a, 'posShareMae').toFixed(4)), chanceShareMae.toFixed(4)])
  );
  console.log(
    row('pos share corr (12 mgrs)', [...ARMS.map((a) => get(a, 'posShareCorr').toFixed(3)), '0.000'])
  );
  console.log(
    row('concentration MAE', [...ARMS.map((a) => get(a, 'concentrationMae').toFixed(4)), '-'])
  );
  console.log(
    row('concentration corr', [...ARMS.map((a) => get(a, 'concentrationCorr').toFixed(3)), '0.000'])
  );
  console.log(
    row('price MAE $ (overlap)', [
      ...ARMS.map((a) => get(a, 'priceMae').toFixed(2)),
      floor.overall.toFixed(2),
    ])
  );
  console.log(
    row('  / noise floor', [
      ...ARMS.map((a) => (get(a, 'priceMae') / floor.overall).toFixed(2)),
      '1.00',
    ])
  );
  console.log(
    row('price signed err $', [...ARMS.map((a) => get(a, 'priceSignedError').toFixed(2)), '-'])
  );
  console.log(
    row('sorted curve MAE $', [...ARMS.map((a) => get(a, 'sortedCurveMae').toFixed(2)), '-'])
  );
  console.log(row('top price $', [...ARMS.map((a) => get(a, 'topPrice').toFixed(1)), '-']));
  console.log(row('median price $', [...ARMS.map((a) => get(a, 'medianPrice').toFixed(1)), '-']));
  console.log(row('price gini', [...ARMS.map((a) => get(a, 'gini').toFixed(3)), '-']));
  console.log(row('deepest rank sold', [...ARMS.map((a) => get(a, 'deepestRank').toFixed(0)), '-']));
  console.log(
    row('snake pos share MAE', [...ARMS.map((a) => get(a, 'snakePosShareMae').toFixed(4)), '-'])
  );
  console.log(
    row('snake pos share corr', [...ARMS.map((a) => get(a, 'snakePosShareCorr').toFixed(3)), '0.000'])
  );
  console.log(
    row('snake soft assign', [...ARMS.map((a) => pct(get(a, 'snakeSoftAssign'))), pct(chanceAssign)])
  );
  console.log(row('snake roster L1', [...ARMS.map((a) => get(a, 'snakeRosterL1').toFixed(2)), '-']));

  // --- price error by rank bucket, fitted arm ---------------------------------
  const fittedCards = byArm.get('fitted')?.[0];
  if (fittedCards) {
    console.log('\nfitted arm, price error by rank bucket:');
    console.log('bucket         n   coverage    MAE $   medAE $   signed $   rel AE   floor $');
    for (const [, , label] of BUCKETS) {
      const rows = fittedCards.flatMap((c) => c.buckets.filter((b) => b.label === label));
      if (rows.length === 0) continue;
      const weight = rows.reduce((a, b) => a + b.n, 0);
      const w = (get2: (b: (typeof rows)[number]) => number) =>
        rows.reduce((a, b) => a + get2(b) * b.n, 0) / weight;
      console.log(
        `${label.padEnd(9)} ${String(weight).padStart(6)}   ${pct(w((b) => b.coverage)).padStart(7)}  ` +
          `${w((b) => b.mae).toFixed(2).padStart(7)}  ${w((b) => b.medianAe).toFixed(2).padStart(8)}  ` +
          `${w((b) => b.signedError).toFixed(2).padStart(9)}  ${w((b) => b.relativeAe).toFixed(2).padStart(7)}  ` +
          `${(floor.byBucket.get(label) ?? 0).toFixed(2).padStart(8)}`
      );
    }
  }

  // --- per-manager positional share, fitted vs actual --------------------------
  if (fittedCards) {
    console.log('\nper-year detail (fitted arm):');
    console.log('year   coverage   softAssign   posShareMAE   posShareCorr   priceMAE $');
    for (const card of fittedCards) {
      console.log(
        `${card.year}   ${pct(card.coverage).padStart(8)}   ${pct(card.softAssign).padStart(10)}   ` +
          `${card.posShareMae.toFixed(4).padStart(11)}   ${card.posShareCorr.toFixed(3).padStart(12)}   ` +
          `${card.priceMae.toFixed(2).padStart(10)}`
      );
    }
  }

  // --- harness noise floor ----------------------------------------------------
  if (BATCHES > 1) {
    console.log(`\nbetween-batch sd over ${BATCHES} disjoint seed batches (the harness's own noise;`);
    console.log('no later improvement is real unless it is larger than this):');
    for (const armName of ARMS) {
      const batchSummaries = byArm.get(armName)!.map(summarize);
      const sdOf = (key: string) => {
        const v = batchSummaries.map((s) => s[key]);
        const m = mean(v);
        return Math.sqrt(mean(v.map((x) => (x - m) ** 2)));
      };
      console.log(
        `  ${armName.padEnd(9)} softAssign ${sdOf('softAssign').toFixed(4)}   ` +
          `posShareMAE ${sdOf('posShareMae').toFixed(5)}   ` +
          `posShareCorr ${sdOf('posShareCorr').toFixed(4)}   ` +
          `priceMAE ${sdOf('priceMae').toFixed(3)}`
      );
    }
  }

  // --- the gate ---------------------------------------------------------------
  if (ARMS.includes('fitted') && ARMS.includes('neutral')) {
    const f = summaries.get('fitted')!;
    const n = summaries.get('neutral')!;
    console.log('\nGATE (does the per-manager profile layer earn its keep?):');
    console.log(
      `  pos share MAE   fitted ${f.posShareMae.toFixed(4)} vs neutral ${n.posShareMae.toFixed(4)}  ` +
        `-> ${(((n.posShareMae - f.posShareMae) / n.posShareMae) * 100).toFixed(1)}% better`
    );
    console.log(
      `  soft assign     fitted ${pct(f.softAssign)} vs neutral ${pct(n.softAssign)}  ` +
        `-> ${(((f.softAssign - n.softAssign) / n.softAssign) * 100).toFixed(1)}% better`
    );
    console.log(
      `  pos share corr  fitted ${f.posShareCorr.toFixed(3)} vs neutral ${n.posShareCorr.toFixed(3)}`
    );
  }

  if (JSON_OUT) {
    writeFileSync(
      JSON_OUT,
      JSON.stringify(
        {
          seeds: SEEDS,
          batches: BATCHES,
          years,
          noiseFloor: { overall: floor.overall, byBucket: Object.fromEntries(floor.byBucket) },
          chance: { softAssign: chanceAssign, posShareMae: chanceShareMae },
          arms: Object.fromEntries(
            ARMS.map((a) => [a, { summary: summaries.get(a), cards: byArm.get(a)![0] }])
          ),
        },
        null,
        2
      )
    );
    console.log(`\nwrote ${JSON_OUT}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
