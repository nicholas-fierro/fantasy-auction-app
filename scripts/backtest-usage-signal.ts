#!/usr/bin/env -S npx tsx
// Workstream 1 of docs/auction-research-plan.md: does prior-season usage predict
// which cheap auction buys ($1-20) return starter-level points?
//
// For every official auction year 2019-2025, take that year's $1-20 buys, build
// usage features from their season Y-1 game logs, and ask whether those features
// separate the hits from the misses out of sample. Scored leave-one-season-out
// against two nulls (preseason positional rank alone, price alone) — the usage
// model has to beat both or it adds nothing over what the draft board shows.
//
// The replacement baseline is the season total of the median weekly score among
// that year's $0 (snake) picks — literally what the league got for free. Every
// year now has its snake rounds recorded, so no rank-band approximation is used.
//
// Usage:
//   npx tsx scripts/backtest-usage-signal.ts --data <dump.json>
//   PB_SUPERUSER_EMAIL=... PB_SUPERUSER_PASSWORD=... npx tsx scripts/backtest-usage-signal.ts
//   ... --shortlist        also print 2026 $1-20 candidates ranked by the model
//
// The dump for --data is {auctions, picks, seasons, players, gameLogs} — see
// loadFromDump below for the expected field names.

import PocketBase from 'pocketbase';
import {
  ALL_FEATURE_NAMES,
  FEATURE_NAMES,
  PRICED_SNAP_AGE_FEATURE_NAMES,
  SNAP_AGE_FEATURE_NAMES,
  SNAP_FEATURE_NAMES,
  ageAtSeason,
  applyStandardizer,
  buildUsageFeatures,
  featureVector,
  fitLogistic,
  fitStandardizer,
  leaveOneSeasonOut,
  median,
  predictLogistic,
  pricedSnapAgeVector,
  replacementBaselines,
  seasonPoints,
  snapAgeVector,
  spearman,
  usageSnapAgeVector,
  type BacktestResult,
  type CohortRow,
  type GameLogRow,
  type UsageFeatures,
} from '../src/lib/usage-signal';
import { readFileSync } from 'fs';

const POCKETBASE_URL = process.env.POCKETBASE_URL || 'http://127.0.0.1:8090';

// Cohort definition, fixed by the plan before any of this was run.
const COHORT_YEARS = [2019, 2020, 2021, 2022, 2023, 2024, 2025];
const CHEAP_MIN = 1;
const CHEAP_MAX = 20;
// The features describe rushing and receiving usage, so the model covers the
// skill positions. QBs are counted and reported but not modelled — passing volume
// is a different feature set that the plan does not specify.
const MODELLED_POSITIONS = new Set(['RB', 'WR', 'TE']);
// "Hit" = the player finished as a startable starter in a 12-team league.
const HIT_THRESHOLD: Record<string, number> = { RB: 24, WR: 24, TE: 12, QB: 12 };
// Pre-registered bars from docs/auction-research-plan.md.
const AUC_STRONG = 0.65;
const AUC_WEAK = 0.55;
const NULL_BEAT_YEARS = 5;
// What the touch-only run already achieved (PR #89, docs/usage-signal-results.md).
// Snap counts and age were imported to beat these, not to beat 0.5.
const PRIOR_TOUCH_AUC = 0.514;
const PRIOR_STACK_AUC = 0.61;

interface Args {
  data: string | null;
  shortlist: boolean;
}

function parseArgs(argv: string[]): Args {
  let data: string | null = null;
  let shortlist = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--data') data = argv[++i] ?? '';
    else if (arg === '--shortlist') shortlist = true;
    else throw new Error(`Unknown argument: "${arg}"`);
  }
  return { data, shortlist };
}

interface Auction {
  id: string;
  year: number;
}
interface Pick {
  auction_id: string;
  player_id: string;
  price: number;
}
interface Season {
  player_id: string;
  year: number;
  position_rank: number;
  projected_auction_value: number;
}
interface Player {
  id: string;
  name: string;
  position: string;
  birth_date: string;
}
interface Data {
  auctions: Auction[];
  picks: Pick[];
  seasons: Season[];
  players: Map<string, Player>;
  gameLogs: GameLogRow[];
}

async function loadFromPocketBase(pb: PocketBase): Promise<Data> {
  const auctionRecords = await pb.collection('auctions').getFullList({
    filter: pb.filter('type = "official" && year > 0'),
    requestKey: null,
  });
  const auctions: Auction[] = auctionRecords.map((a) => ({ id: a.id, year: Number(a.year) }));

  const picks: Pick[] = [];
  for (const auction of auctions) {
    const records = await pb.collection('draft_picks').getFullList({
      filter: pb.filter('auction_id = {:id}', { id: auction.id }),
      requestKey: null,
    });
    for (const pick of records) {
      picks.push({
        auction_id: auction.id,
        player_id: String(pick.player_id),
        price: Number(pick.price ?? 0),
      });
    }
  }

  const seasonRecords = await pb.collection('player_seasons').getFullList({ requestKey: null });
  const seasons: Season[] = seasonRecords.map((s) => ({
    player_id: String(s.player_id),
    year: Number(s.year),
    position_rank: Number(s.position_rank ?? 0),
    projected_auction_value: Number(s.projected_auction_value ?? 0),
  }));

  const playerRecords = await pb.collection('players').getFullList({ requestKey: null });
  const players = new Map<string, Player>(
    playerRecords.map((p) => [
      p.id,
      {
        id: p.id,
        name: String(p.name ?? ''),
        position: String(p.position ?? ''),
        birth_date: String(p.birth_date ?? ''),
      },
    ])
  );

  // ~51k rows; paged rather than getFullList so a slow instance still finishes.
  const gameLogs: GameLogRow[] = [];
  for (let page = 1; ; page++) {
    const result = await pb.collection('player_game_logs').getList(page, 1000, {
      filter: pb.filter('season_type = "REG"'),
      requestKey: null,
    });
    for (const row of result.items) {
      gameLogs.push({
        player_id: String(row.player_id),
        season: Number(row.season),
        week: Number(row.week),
        team: String(row.team ?? ''),
        stats: (row.stats ?? {}) as GameLogRow['stats'],
      });
    }
    if (page >= result.totalPages) break;
  }

  return { auctions, picks, seasons, players, gameLogs };
}

function loadFromDump(path: string): Data {
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  return {
    auctions: raw.auctions.map((a: Record<string, unknown>) => ({
      id: String(a.id),
      year: Number(a.year),
    })),
    picks: raw.picks.map((p: Record<string, unknown>) => ({
      auction_id: String(p.auction_id),
      player_id: String(p.player_id),
      price: Number(p.price ?? 0),
    })),
    seasons: raw.seasons.map((s: Record<string, unknown>) => ({
      player_id: String(s.player_id),
      year: Number(s.year),
      position_rank: Number(s.position_rank ?? 0),
      projected_auction_value: Number(s.projected_auction_value ?? 0),
    })),
    players: new Map(
      raw.players.map((p: Record<string, unknown>) => [
        String(p.id),
        {
          id: String(p.id),
          name: String(p.name ?? ''),
          position: String(p.position ?? ''),
          birth_date: String(p.birth_date ?? ''),
        },
      ])
    ),
    gameLogs: raw.gameLogs.map((g: Record<string, unknown>) => ({
      player_id: String(g.player_id),
      season: Number(g.season),
      week: Number(g.week),
      team: String(g.team ?? ''),
      stats: (g.stats ?? {}) as GameLogRow['stats'],
    })),
  };
}

/** Season-Y finishes by position, used to label a hit. */
function positionFinishes(
  points: ReadonlyMap<string, number>,
  players: ReadonlyMap<string, Player>,
  year: number
): Map<string, number> {
  const byPosition = new Map<string, { id: string; points: number }[]>();
  for (const [k, value] of points) {
    const [playerId, season] = k.split('|');
    if (Number(season) !== year) continue;
    const position = players.get(playerId)?.position;
    if (!position) continue;
    const bucket = byPosition.get(position);
    if (bucket) bucket.push({ id: playerId, points: value });
    else byPosition.set(position, [{ id: playerId, points: value }]);
  }
  const finishes = new Map<string, number>();
  for (const [, rows] of byPosition) {
    rows.sort((a, b) => b.points - a.points);
    rows.forEach((row, index) => finishes.set(row.id, index + 1));
  }
  return finishes;
}

function fmt(value: number, digits = 3): string {
  return Number.isFinite(value) ? value.toFixed(digits) : '  n/a';
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let data: Data;
  if (args.data) {
    data = loadFromDump(args.data);
  } else {
    const pb = new PocketBase(POCKETBASE_URL);
    const email = process.env.PB_SUPERUSER_EMAIL;
    const password = process.env.PB_SUPERUSER_PASSWORD;
    if (!email || !password) {
      throw new Error('Set PB_SUPERUSER_EMAIL and PB_SUPERUSER_PASSWORD, or pass --data <dump.json>');
    }
    await pb.collection('_superusers').authWithPassword(email, password);
    data = await loadFromPocketBase(pb);
  }

  const auctionYear = new Map(data.auctions.map((a) => [a.id, a.year]));
  const positionOf = new Map([...data.players].map(([id, p]) => [id, p.position]));

  const freePicksBySeason = new Map<number, string[]>();
  const pricedByYear = new Map<number, Pick[]>();
  for (const pick of data.picks) {
    const year = auctionYear.get(pick.auction_id);
    if (year === undefined) continue;
    if (pick.price > 0) {
      const bucket = pricedByYear.get(year);
      if (bucket) bucket.push(pick);
      else pricedByYear.set(year, [pick]);
    } else {
      const bucket = freePicksBySeason.get(year);
      if (bucket) bucket.push(pick.player_id);
      else freePicksBySeason.set(year, [pick.player_id]);
    }
  }

  const points = seasonPoints(data.gameLogs);
  const baselines = replacementBaselines(data.gameLogs, freePicksBySeason, positionOf);

  const featuresBySeason = new Map<number, Map<string, UsageFeatures>>();
  for (const year of new Set(data.gameLogs.map((log) => log.season))) {
    featuresBySeason.set(
      year,
      buildUsageFeatures(data.gameLogs.filter((log) => log.season === year))
    );
  }

  const seasonRow = new Map(data.seasons.map((s) => [`${s.player_id}|${s.year}`, s]));

  const cohort: CohortRow[] = [];
  let noPriorData = 0;
  let quarterbacks = 0;
  for (const year of COHORT_YEARS) {
    const finishes = positionFinishes(points, data.players, year);
    for (const pick of pricedByYear.get(year) ?? []) {
      if (pick.price < CHEAP_MIN || pick.price > CHEAP_MAX) continue;
      const player = data.players.get(pick.player_id);
      if (!player) continue;
      if (player.position === 'QB') quarterbacks++;
      if (!MODELLED_POSITIONS.has(player.position)) continue;

      const prior = featuresBySeason.get(year - 1)?.get(pick.player_id);
      if (!prior || prior.games_played === 0) {
        noPriorData++;
        continue;
      }
      const seasonTotal = points.get(`${pick.player_id}|${year}`) ?? 0;
      const baseline = baselines.get(`${year}|${player.position}`) ?? 0;
      const finish = finishes.get(pick.player_id) ?? Number.MAX_SAFE_INTEGER;
      cohort.push({
        year,
        playerId: pick.player_id,
        name: player.name,
        position: player.position,
        price: pick.price,
        positionRank: seasonRow.get(`${pick.player_id}|${year}`)?.position_rank ?? 999,
        features: prior,
        // Imputed below where the birth date is missing; NaN would poison the fit.
        age: ageAtSeason(player.birth_date, year) ?? NaN,
        points: seasonTotal,
        surplus: seasonTotal - baseline,
        hit: finish <= HIT_THRESHOLD[player.position] ? 1 : 0,
      });
    }
  }

  // Missing birth dates take the cohort median rather than 0, which would sit
  // far outside the real range and drag the standardizer with it.
  const knownAges = cohort.map((row) => row.age).filter((age) => Number.isFinite(age));
  const medianAge = median(knownAges);
  let imputedAges = 0;
  for (const row of cohort) {
    if (!Number.isFinite(row.age)) {
      row.age = medianAge;
      imputedAges++;
    }
  }
  const withSnaps = cohort.filter((row) => row.features.snap_pct > 0).length;

  console.log('=== cohort ===');
  console.log(
    `${cohort.length} rows, ${COHORT_YEARS[0]}-${COHORT_YEARS[COHORT_YEARS.length - 1]}, ` +
      `$${CHEAP_MIN}-${CHEAP_MAX} buys at ${[...MODELLED_POSITIONS].join('/')}`
  );
  console.log(
    `dropped: ${noPriorData} with no season Y-1 game logs (rookies and the ` +
      `genuinely irreducible part of the lottery), ${quarterbacks} QBs (not modelled)`
  );
  const hits = cohort.reduce((sum, row) => sum + row.hit, 0);
  console.log(`hit rate: ${hits}/${cohort.length} (${((100 * hits) / cohort.length).toFixed(0)}%)`);
  console.log(
    `snap data: ${withSnaps}/${cohort.length} rows; age: ${cohort.length - imputedAges}/${cohort.length} ` +
      `known (median ${fmt(medianAge, 1)}, ${imputedAges} imputed)`
  );
  if (withSnaps < cohort.length * 0.9) {
    console.log('WARNING: snap coverage is thin — run scripts/import-nflverse-snap-counts.ts for every');
    console.log('season Y-1 in the cohort before trusting the snap arms.');
  }
  for (const year of COHORT_YEARS) {
    const rows = cohort.filter((row) => row.year === year);
    const yearHits = rows.reduce((sum, row) => sum + row.hit, 0);
    console.log(`  ${year}: n=${String(rows.length).padStart(2)} hits=${yearHits}`);
  }

  console.log('\n=== per-feature Spearman vs surplus over replacement ===');
  for (const name of [...FEATURE_NAMES, ...SNAP_FEATURE_NAMES]) {
    const rho = spearman(
      cohort.map((row) => row.features[name]),
      cohort.map((row) => row.surplus)
    );
    console.log(`  ${name.padEnd(22)} ${rho >= 0 ? '+' : ''}${fmt(rho, 2)}`);
  }
  const ageRho = spearman(
    cohort.map((row) => row.age),
    cohort.map((row) => row.surplus)
  );
  console.log(`  ${'age'.padEnd(22)} ${ageRho >= 0 ? '+' : ''}${fmt(ageRho, 2)}`);

  console.log('\n=== leave-one-season-out AUC ===');
  const rankNull = leaveOneSeasonOut(cohort, (row) => [-row.positionRank], undefined, ['neg_rank']);
  const priceNull = leaveOneSeasonOut(cohort, (row) => [row.price], undefined, ['price']);
  const arms: { label: string; result: BacktestResult }[] = [
    { label: 'touches', result: leaveOneSeasonOut(cohort, featureVector, undefined, FEATURE_NAMES) },
    // The within-run control for the stacked arm. PR #89's 0.610 was measured on
    // game logs that did not yet contain the zero-production rows the snap
    // importer creates, so comparing across runs would not be like for like.
    {
      label: 'price+rank',
      result: leaveOneSeasonOut(cohort, (row) => [row.price, -row.positionRank], undefined, [
        'price',
        'neg_position_rank',
      ]),
    },
    {
      label: 'snap+age',
      result: leaveOneSeasonOut(cohort, snapAgeVector, undefined, SNAP_AGE_FEATURE_NAMES),
    },
    {
      label: 'all',
      result: leaveOneSeasonOut(cohort, usageSnapAgeVector, undefined, ALL_FEATURE_NAMES),
    },
    {
      label: 'price+rank+snap+age',
      result: leaveOneSeasonOut(cohort, pricedSnapAgeVector, undefined, PRICED_SNAP_AGE_FEATURE_NAMES),
    },
  ];
  // The arm that would actually change a draft board — everything the board
  // already knows, plus the new data.
  const stacked = arms[arms.length - 1].result;
  const snapArm = arms[2].result;
  const priceRank = arms[1].result;

  const header = ['year', 'n', 'hits', 'rank', 'price', ...arms.map((arm) => arm.label)];
  console.log(
    header[0].padEnd(6) +
      header[1].padStart(4) +
      header[2].padStart(6) +
      header.slice(3).map((label) => label.padStart(20)).join('')
  );
  let beatsBoth = 0;
  const folds = arms[0].result.folds;
  for (let i = 0; i < folds.length; i++) {
    const rank = rankNull.folds[i]?.auc ?? NaN;
    const price = priceNull.folds[i]?.auc ?? NaN;
    const snapAuc = snapArm.folds[i]?.auc ?? NaN;
    if (Number.isFinite(snapAuc) && snapAuc > rank && snapAuc > price) beatsBoth++;
    console.log(
      String(folds[i].year).padEnd(6) +
        String(folds[i].n).padStart(4) +
        String(folds[i].positives).padStart(6) +
        [rank, price, ...arms.map((arm) => arm.result.folds[i]?.auc ?? NaN)]
          .map((value) => fmt(value).padStart(20))
          .join('')
    );
  }
  console.log(
    'mean'.padEnd(16) +
      [rankNull.meanAuc, priceNull.meanAuc, ...arms.map((arm) => arm.result.meanAuc)]
        .map((value) => fmt(value).padStart(20))
        .join('')
  );
  console.log(`snap+age beats both nulls in ${beatsBoth}/${folds.length} seasons`);
  console.log(
    `prior run (touches only, PR #89): ${fmt(PRIOR_TOUCH_AUC)} usage, ${fmt(PRIOR_STACK_AUC)} stacked`
  );

  console.log('\n=== full-cohort coefficients, price+rank+snap+age (in-sample, interpretation only) ===');
  for (const { feature, weight } of [...stacked.fullFitWeights].sort(
    (a, b) => Math.abs(b.weight) - Math.abs(a.weight)
  )) {
    console.log(`  ${feature.padEnd(22)} ${weight >= 0 ? '+' : ''}${fmt(weight, 3)}`);
  }

  console.log('\n=== verdict ===');
  // Two bars. The pre-registered one asks whether the new data carries signal at
  // all; the second asks the only question that matters for the draft board —
  // does it add anything on top of price and rank, which already work.
  if (snapArm.meanAuc >= AUC_STRONG && beatsBoth >= NULL_BEAT_YEARS) {
    console.log(`REAL SIGNAL: snap+age mean AUC ${fmt(snapArm.meanAuc)} >= ${AUC_STRONG} and beat both`);
    console.log(`nulls in ${beatsBoth} seasons.`);
  } else if (snapArm.meanAuc >= AUC_WEAK) {
    console.log(`WEAK SIGNAL: snap+age mean AUC ${fmt(snapArm.meanAuc)} is in [${AUC_WEAK}, ${AUC_STRONG}).`);
  } else {
    console.log(`NO SIGNAL: snap+age mean AUC ${fmt(snapArm.meanAuc)} < ${AUC_WEAK}.`);
    console.log('Opportunity share is priced in too. The cheap tier is a lottery on this data.');
  }
  const bar = Math.max(priceRank.meanAuc, PRIOR_STACK_AUC);
  if (stacked.meanAuc > bar) {
    console.log(
      `Stacked arm ${fmt(stacked.meanAuc)} > ${fmt(bar)} (price+rank on this same data, and the ` +
        `${fmt(PRIOR_STACK_AUC)} from PR #89): the new data adds to what the board already shows.`
    );
  } else {
    console.log(
      `Stacked arm ${fmt(stacked.meanAuc)} <= ${fmt(bar)}: nothing here changes a draft board.`
    );
  }

  if (!args.shortlist) return;

  console.log('\n=== 2026 $1-20 candidates, ranked ===');
  if (stacked.meanAuc < AUC_WEAK || stacked.meanAuc <= bar) {
    console.log('Skipped: the model did not clear the weak-signal bar, or did not improve on');
    console.log('price+rank alone, so this ranking would be noise dressed up as a shortlist.');
    return;
  }
  const std = fitStandardizer(cohort.map(pricedSnapAgeVector));
  const model = fitLogistic(
    applyStandardizer(cohort.map(pricedSnapAgeVector), std),
    cohort.map((row) => row.hit)
  );
  const priorYear = featuresBySeason.get(2025);
  const candidates = data.seasons
    .filter(
      (s) =>
        s.year === 2026 &&
        s.projected_auction_value >= CHEAP_MIN &&
        s.projected_auction_value <= CHEAP_MAX &&
        MODELLED_POSITIONS.has(data.players.get(s.player_id)?.position ?? '')
    )
    .map((s) => ({ season: s, features: priorYear?.get(s.player_id) }))
    .filter((c): c is { season: Season; features: UsageFeatures } => c.features !== undefined);

  // Same vector builder as the fit, so a candidate is scored exactly as the
  // backtest rows were. Price stands in as the projected auction value.
  const candidateRows: CohortRow[] = candidates.map((c) => ({
    year: 2026,
    playerId: c.season.player_id,
    name: data.players.get(c.season.player_id)?.name ?? '',
    position: data.players.get(c.season.player_id)?.position ?? '',
    price: c.season.projected_auction_value,
    positionRank: c.season.position_rank || 999,
    features: c.features,
    age: ageAtSeason(data.players.get(c.season.player_id)?.birth_date, 2026) ?? medianAge,
    points: 0,
    surplus: 0,
    hit: 0,
  }));

  const scores = predictLogistic(
    model,
    applyStandardizer(candidateRows.map(pricedSnapAgeVector), std)
  );
  candidateRows
    .map((row, i) => ({ row, score: scores[i] }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 25)
    .forEach(({ row, score }) => {
      console.log(
        `  ${fmt(score, 2)}  $${String(row.price).padStart(2)}  ${row.position} ${row.name}`
      );
    });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
