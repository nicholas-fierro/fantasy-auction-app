#!/usr/bin/env -S npx tsx
// Fits the three shared constants that control the mock auction's price curve.
//
// SCOPE. Only three parameters are free, and none of them is per-manager. The
// leave-one-year-out backtest (scripts/backtest-mock-draft-behavior.ts) showed the
// per-manager profile layer scoring at chance against a league of twelve identical
// average managers, so fitting it would be fitting noise. What DID survive that
// backtest is a systematic tilt in the price curve: the sim overpays at the top of
// the board (+$7.3 at ranks 1-6) and underpays through the middle (-$3.0 at ranks
// 49-84). That tilt is a shared-constant problem, and these are the constants:
//
//   ceilMin, ceilMax   the per-team WTP ceiling as a multiple of the league value.
//                      For an elite player the factor stack is almost always above
//                      this ceiling, so the ceiling IS the top-of-board price and
//                      nothing else can move it.
//   posBudgetSlack     how hard a team's positional budget fades its depth buys,
//                      which is where the middle of the board is priced.
//
// OBJECTIVE. Dollars, on the holdout years, two terms:
//   priceMae        mean absolute price error on the players the sim and the real
//                   draft both bought.
//   sortedCurveMae  the same drafts' 84 prices sorted high to low and compared
//                   position by position. This term needs no player matching, so
//                   it is the guard against "improving" the MAE by buying a
//                   different, easier set of players.
//
// NOISE CONTROL. Common random numbers: every candidate vector is scored on the
// same fixed seed list. This is imperfect by construction — the rng keys include
// the pick order and the player id, so a parameter change that moves a nomination
// desynchronizes the streams — which is a second reason the vector is three
// parameters wide and the optimizer is derivative-free.
//
// Usage:
//   set -a; source .env; set +a
//   npx tsx scripts/fit-mock-draft-params.ts [--seeds 8] [--evals 120]
//     [--folds all|none] [--write]
import PocketBase from 'pocketbase';
import { writeFileSync } from 'node:fs';
import {
  buildBoard,
  buildHistoryIndexBefore,
  buildProfilesBefore,
  loadLeagueDraftData,
  runDraft,
  settingsForYear,
  type LeagueDraftData,
} from '@/server/lib/mock-draft-data';
import {
  BUCKETS,
  mean,
  scoreDraft,
  toScoredPicks,
  type Scorecard,
  type ScoredPick,
} from '@/server/lib/mock-draft-score';
import { DEFAULT_PARAMS, type MockDraftParams } from '@/lib/mock-draft/params';
import type { HistoryIndex } from '@/lib/estimated-value';
import type { Player } from '@/server/types/player';
import type { TeamProfile } from '@/lib/mock-draft/types';

const pb = new PocketBase(process.env.POCKETBASE_URL || 'http://127.0.0.1:8090');

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const SEEDS = Number(arg('seeds', '8'));
const MAX_EVALS = Number(arg('evals', '120'));
const FOLDS = arg('folds', 'all');
const WRITE = process.argv.includes('--write');

// --- the free vector ---------------------------------------------------------

const KEYS = ['ceilMin', 'ceilMax', 'posBudgetSlack', 'marketMeanScale'] as const;
type Key = (typeof KEYS)[number];

// The ceiling floor was pinned at 1.0 by decision, so that no fit could forbid a
// team from bidding above the model value. That decision is reversed, because the
// thing it was protecting turned out not to be true.
//
// At the top of the board the factor stack sits 1.3-1.5x above the model value for
// every bidder, so all twelve clamp to the ceiling and the clearing price becomes
// the second-highest of twelve draws from U(ceilMin, ceilMax). With ceilMin at 1.0
// that is a one-sided floor: an elite player could never clear below his comp
// value, and the price carried a deterministic +8.5% (measured 1.087, predicted
// 1 + 0.1*(11/13) = 1.0846). Ranks 1-6 ran ~$84 against $80 on the imported board,
// with 3.1 picks per draft at $85+ against 1.6-2.0 in real ones.
//
// What real rooms do, measured as price / comp-model estimate at ranks 1-12, each
// year priced only off years before it:
//
//   this league 2019-2025  n=72  p10 0.893  median 0.987  p90 1.091  max 1.161
//   external board 2026    n=12  p10 0.904  median 0.986  p90 1.063  max 1.091
//
// They pay the model value at the top and miss BOTH ways. Every year lands between
// 0.95 and 1.06. So the floor below 1.0 is not "no bidding wars, no overpays" — the
// overpays live in the upper half of that same interval, and forbidding the lower
// half is what produced the tilt. ceilMin is free below 1.0, and ranks 1-12 are
// back in the objective: the tier is no longer being withheld from the fit, so the
// fit is scored on the whole board it prices. MIN_CEIL_WIDTH still keeps the
// ceiling an interval, which is what preserves the spread.
const BOUNDS: Record<Key, [number, number]> = {
  ceilMin: [0.8, 1.4],
  ceilMax: [1.0, 2.0],
  posBudgetSlack: [1.0, 3.0],
  marketMeanScale: [0, 2],
};

// Every ranked pick is in scope. This was 13 while ranks 1-12 were held out of the
// objective; see BOUNDS above for why they no longer are. Rank 0 (2018, no rank
// data imported) is still not comparable and stays out.
const FIT_MIN_RANK = 1;

// The ceiling must stay an INTERVAL, never a point. Left free, the fit collapses
// ceilMin and ceilMax onto the same value, which scores well and is a disaster:
// with an identical cap for every team, second-price + $1 between two teams sitting
// on the same value C returns exactly C, so the board's best player clears at the
// same dollar in every mock ever run. That bug is already documented in pricing.ts
// and this is how it comes back. A minimum width keeps the runner-up varying.
const MIN_CEIL_WIDTH = 0.1;

function toParams(v: number[]): MockDraftParams {
  const clamped = KEYS.map((key, i) => {
    const [lo, hi] = BOUNDS[key];
    return Math.min(hi, Math.max(lo, v[i]));
  });
  // The ceiling is an interval, so an optimizer step that inverts it has to be
  // repaired rather than rejected — Nelder-Mead has no notion of a constraint.
  const [lo, hi] = clamped[0] <= clamped[1] ? [clamped[0], clamped[1]] : [clamped[1], clamped[0]];
  const ceilMin = lo;
  const ceilMax = Math.max(hi, lo + MIN_CEIL_WIDTH);
  return {
    ...DEFAULT_PARAMS,
    ceilMin,
    ceilMax,
    posBudgetSlack: clamped[2],
    marketMeanScale: clamped[3],
  };
}

// --- the objective -----------------------------------------------------------

interface YearFixture {
  year: number;
  profiles: Map<string, TeamProfile>;
  index: HistoryIndex;
  board: Player[];
  actual: ScoredPick[]; // every real pick, for the reported tables
  fitActual: ScoredPick[]; // ranks >= FIT_MIN_RANK only, for the objective
}

// Everything that does not depend on the free parameters is built once. The
// profiles do depend on shrinkK, which is NOT free here, so they are fixtures too.
function buildFixtures(data: LeagueDraftData, years: number[]): YearFixture[] {
  return years.map((year) => {
    const actual: ScoredPick[] = data.actual
      .filter((a) => a.year === year)
      .map((a) => ({
        teamId: a.teamId,
        playerId: a.playerId,
        price: a.price,
        position: a.position,
        rank: a.rank,
      }));
    return {
      year,
      profiles: buildProfilesBefore(data, year),
      index: buildHistoryIndexBefore(data, year),
      board: buildBoard(data, year),
      actual,
      // Snake picks (price 0) carry no price evidence either way, so they stay in
      // both lists and are ignored by the price metrics.
      fitActual: actual.filter((a) => a.price === 0 || a.rank >= FIT_MIN_RANK),
    };
  });
}

function scoreYear(
  data: LeagueDraftData,
  fixture: YearFixture,
  params: MockDraftParams,
  forFit = false
): Scorecard {
  const runs: ScoredPick[][] = [];
  for (let seed = 0; seed < SEEDS; seed++) {
    // Common random numbers: the same seed strings for every candidate vector.
    const auctionId = `fit${fixture.year}-${String(seed).padStart(3, '0')}`;
    const picks = runDraft({
      auctionId,
      teams: data.teams,
      profiles: fixture.profiles,
      players: fixture.board,
      index: fixture.index,
      year: fixture.year,
      settings: settingsForYear(fixture.year),
      phases: 'auction',
      params,
    });
    runs.push(toScoredPicks(picks, fixture.board));
  }
  if (!forFit) return scoreDraft(fixture.actual, runs, data.teams, fixture.year);

  // The SIMULATED picks must be cut to the same rank range as the actual ones.
  // `sortedCurveMae` sorts each side's prices and compares them position by
  // position, so an asymmetric cut lines the sim's top buy up against a different
  // player on the actual side and the fitter chases a gap that is an artefact of
  // the filter. At FIT_MIN_RANK 1 this only drops rank 0 (2018, no rank data), but
  // it stays symmetric on purpose: raising the floor again must not reintroduce
  // that bias.
  const fitRuns = runs.map((run) =>
    run.filter((p) => p.price === 0 || p.rank >= FIT_MIN_RANK)
  );
  return scoreDraft(fixture.fitActual, fitRuns, data.teams, fixture.year);
}

// CRPS, not MAE. MAE against the single price the league actually paid is
// minimised at the conditional median, so it charges the sim for every dollar of
// spread — and a spread-free auction cannot overpay, which real rooms do
// constantly. An MAE fit of these same three parameters drove the WTP ceiling to
// 0.85-0.99, i.e. no team could ever bid above the model value. CRPS is proper: it
// is minimised when the sim's price DISTRIBUTION matches the real one.
//
// `sortedCurveMae` stays as the coverage-free guard against "improving" the score
// by buying a different, easier set of players. It is halved because it now plays
// second fiddle to CRPS rather than carrying the objective.
function objective(cards: Scorecard[]): number {
  return mean(cards.map((c) => c.crps)) + 0.5 * mean(cards.map((c) => c.sortedCurveMae));
}

// --- Nelder-Mead -------------------------------------------------------------

// Standard coefficients. Three dimensions, a smooth-enough surface and a hard
// evaluation budget: nothing here justifies a CMA-ES dependency.
function nelderMead(
  f: (v: number[]) => number,
  start: number[],
  step: number[],
  maxEvals: number
): { best: number[]; value: number; evals: number } {
  const n = start.length;
  let evals = 0;
  const evaluate = (v: number[]) => {
    evals++;
    return f(v);
  };

  let simplex = [start, ...start.map((_, i) => start.map((x, j) => (i === j ? x + step[i] : x)))];
  let values = simplex.map(evaluate);

  while (evals < maxEvals) {
    const order = values.map((v, i) => i).sort((a, b) => values[a] - values[b]);
    simplex = order.map((i) => simplex[i]);
    values = order.map((i) => values[i]);

    const centroid = Array.from({ length: n }, (_, j) =>
      mean(simplex.slice(0, n).map((p) => p[j]))
    );
    const worst = simplex[n];

    const reflected = centroid.map((c, j) => c + (c - worst[j]));
    const fr = evaluate(reflected);
    if (fr < values[0]) {
      const expanded = centroid.map((c, j) => c + 2 * (c - worst[j]));
      const fe = evaluate(expanded);
      if (fe < fr) {
        simplex[n] = expanded;
        values[n] = fe;
      } else {
        simplex[n] = reflected;
        values[n] = fr;
      }
    } else if (fr < values[n - 1]) {
      simplex[n] = reflected;
      values[n] = fr;
    } else {
      const contracted = centroid.map((c, j) => c + 0.5 * (worst[j] - c));
      const fc = evaluate(contracted);
      if (fc < values[n]) {
        simplex[n] = contracted;
        values[n] = fc;
      } else {
        for (let i = 1; i <= n; i++) {
          simplex[i] = simplex[i].map((x, j) => simplex[0][j] + 0.5 * (x - simplex[0][j]));
          values[i] = evaluate(simplex[i]);
        }
      }
    }
  }

  const bestIndex = values.indexOf(Math.min(...values));
  return { best: simplex[bestIndex], value: values[bestIndex], evals };
}

// --- report helpers ----------------------------------------------------------

function describe(params: MockDraftParams): string {
  return KEYS.map((k) => `${k} ${params[k].toFixed(3)}`).join('  ');
}

function tiltTable(cards: Scorecard[]): string[] {
  const lines: string[] = [];
  for (const [, , label] of BUCKETS) {
    const rows = cards.flatMap((c) => c.buckets.filter((b) => b.label === label));
    if (rows.length === 0) continue;
    const weight = rows.reduce((a, b) => a + b.n, 0);
    const w = (get: (b: (typeof rows)[number]) => number) =>
      rows.reduce((a, b) => a + get(b) * b.n, 0) / weight;
    lines.push(
      `  ${label.padEnd(7)} n ${String(weight).padStart(5)}   MAE ${w((b) => b.mae).toFixed(2).padStart(6)}   ` +
        `signed ${w((b) => b.signedError).toFixed(2).padStart(7)}   coverage ${(w((b) => b.coverage) * 100).toFixed(1)}%`
    );
  }
  return lines;
}

// --- main --------------------------------------------------------------------

async function main() {
  await pb
    .collection('_superusers')
    .authWithPassword(process.env.PB_SUPERUSER_EMAIL!, process.env.PB_SUPERUSER_PASSWORD!);

  const data = await loadLeagueDraftData(pb);
  // Completed drafts only. A year whose official auction is still active is a
  // half-drafted roster; folding it in would calibrate the shipped parameters
  // against a draft that has not happened yet.
  const years = data.completedYears.filter((y) => y >= 2020);
  const skipped = data.auctionYears.filter((y) => y >= 2020 && !years.includes(y));
  const fixtures = buildFixtures(data, years);

  if (skipped.length > 0) {
    console.log(`skipping ${skipped.join(', ')}: official auction not completed\n`);
  }

  console.log(
    `fitting ${KEYS.join(', ')} on ${years.join(', ')} | ${SEEDS} seeds/year | ` +
      `budget ${MAX_EVALS} evaluations\n`
  );

  const start = KEYS.map((k) => DEFAULT_PARAMS[k]);
  // A generous initial simplex. The shipped ceiling sits ~0.18 away from where a
  // probe says the surface improves, and a 12%-of-range step took more evaluations
  // to walk that far than the budget allows.
  const step = KEYS.map((k) => (BOUNDS[k][1] - BOUNDS[k][0]) * 0.3);

  const fit = (trainFixtures: YearFixture[], label: string) => {
    let count = 0;
    const result = nelderMead(
      (v) => {
        const params = toParams(v);
        const value = objective(trainFixtures.map((fx) => scoreYear(data, fx, params, true)));
        count++;
        if (count % 20 === 0) process.stdout.write(`    ${label} eval ${count}: ${value.toFixed(3)}\n`);
        return value;
      },
      start,
      step,
      MAX_EVALS
    );
    return { params: toParams(result.best), value: result.value };
  };

  // --- baseline ---------------------------------------------------------------
  const baseCards = fixtures.map((fx) => scoreYear(data, fx, DEFAULT_PARAMS));
  // Scored on the same rank subset the fit optimises, otherwise "fitted vs
  // baseline" compares two different populations and can read as a regression
  // while every bucket improved.
  const baseValue = objective(fixtures.map((fx) => scoreYear(data, fx, DEFAULT_PARAMS, true)));
  console.log(`baseline (shipped defaults):  objective ${baseValue.toFixed(3)}`);
  console.log(`  ${describe(DEFAULT_PARAMS)}`);
  console.log(
    `  priceMAE ${mean(baseCards.map((c) => c.priceMae)).toFixed(2)}  ` +
      `curveMAE ${mean(baseCards.map((c) => c.sortedCurveMae)).toFixed(2)}  ` +
      `signed ${mean(baseCards.map((c) => c.priceSignedError)).toFixed(2)}  ` +
      `coverage ${(mean(baseCards.map((c) => c.coverage)) * 100).toFixed(1)}%`
  );
  for (const line of tiltTable(baseCards)) console.log(line);

  // --- fit on every year ------------------------------------------------------
  console.log('\nfitting on all holdout years...');
  const full = fit(fixtures, 'all');
  const fullCards = fixtures.map((fx) => scoreYear(data, fx, full.params));
  console.log(`\nfitted:  objective ${full.value.toFixed(3)}  (baseline ${baseValue.toFixed(3)})`);
  console.log(`  ${describe(full.params)}`);
  console.log(
    `  priceMAE ${mean(fullCards.map((c) => c.priceMae)).toFixed(2)}  ` +
      `curveMAE ${mean(fullCards.map((c) => c.sortedCurveMae)).toFixed(2)}  ` +
      `signed ${mean(fullCards.map((c) => c.priceSignedError)).toFixed(2)}  ` +
      `coverage ${(mean(fullCards.map((c) => c.coverage)) * 100).toFixed(1)}%`
  );
  for (const line of tiltTable(fullCards)) console.log(line);

  // --- nested holdout: the overfit guard --------------------------------------
  // Parameter instability across the folds is the most readable overfit signal
  // there is. If a value swings across its whole range, it is not identified.
  if (FOLDS === 'all') {
    console.log('\nnested leave-one-year-out (fit on five years, score on the sixth):');
    console.log('year   in-sample   out-of-sample   baseline OOS   ceilMin  ceilMax  slack');
    const foldParams: MockDraftParams[] = [];
    for (const fixture of fixtures) {
      const train = fixtures.filter((f) => f.year !== fixture.year);
      const folded = fit(train, String(fixture.year));
      foldParams.push(folded.params);
      const oos = objective([scoreYear(data, fixture, folded.params)]);
      const baseOos = objective([scoreYear(data, fixture, DEFAULT_PARAMS)]);
      console.log(
        `${fixture.year}   ${folded.value.toFixed(3).padStart(9)}   ${oos.toFixed(3).padStart(13)}   ` +
          `${baseOos.toFixed(3).padStart(12)}   ${folded.params.ceilMin.toFixed(3).padStart(7)}  ` +
          `${folded.params.ceilMax.toFixed(3).padStart(7)}  ${folded.params.posBudgetSlack.toFixed(3).padStart(5)}`
      );
    }
    console.log('\nparameter stability across the folds (a wide range means not identified):');
    for (const key of KEYS) {
      const values = foldParams.map((p) => p[key]);
      console.log(
        `  ${key.padEnd(15)} min ${Math.min(...values).toFixed(3)}  max ${Math.max(...values).toFixed(3)}  ` +
          `mean ${mean(values).toFixed(3)}  (bounds ${BOUNDS[key][0]}-${BOUNDS[key][1]})`
      );
    }
  }

  if (WRITE) {
    const path = 'src/lib/mock-draft/params.json';
    writeFileSync(
      path,
      `${JSON.stringify(
        {
          meta: {
            fittedAt: new Date().toISOString().slice(0, 10),
            years,
            seeds: SEEDS,
            objective: Number(full.value.toFixed(4)),
            baselineObjective: Number(baseValue.toFixed(4)),
            script: 'scripts/fit-mock-draft-params.ts',
            note: 'Only the price-curve constants are fitted. The per-manager profile layer scores at chance on the leave-one-year-out backtest, so it is deliberately not fitted. ceilMin is free below 1.0 and ranks 1-12 are inside the objective — see BOUNDS in the fitting script for the measurement that reversed the earlier decision to pin them.',
          },
          params: Object.fromEntries(KEYS.map((k) => [k, Number(full.params[k].toFixed(4))])),
        },
        null,
        2
      )}\n`
    );
    console.log(`\nwrote ${path}`);
  } else {
    console.log('\n(dry run — pass --write to update src/lib/mock-draft/params.json)');
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
