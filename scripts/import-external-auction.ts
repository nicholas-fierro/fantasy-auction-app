#!/usr/bin/env -S npx tsx
// Imports another league's completed auction as market data for the League
// Value Model, without attaching it to this app's league.
//
// The model's history is league-agnostic: buildHistory (src/server/lib/
// value-data.ts) reduces every pick to { year, position, position_rank, rank,
// price }. Any auction of the same shape — 12 teams, $200, N paid slots — is
// the same data type as our own, so an outside league's board is usable comp
// material.
//
// Isolation comes from an explicit `external` flag, not a separate collection.
// Migration 1784380000 grants every authenticated user READ access to flagged
// auctions and their picks, so both pricing paths — the CLI and the in-app
// "Recalculate Projected Prices" button — see identical inputs and cannot
// disagree. Writes stay superuser-only.
//
// The flag is also what keeps these out of the league: auction-context filters
// them from the auctions list, so an external board is never selectable, never
// enterable, and never mistaken for an official draft. The value model
// discounts its rows by ValueModelConfig.externalWeight — another league is
// evidence about the market, not a transcript of what our league would do.
//
// Picks are written with no fantasy_team_id (the field is optional): these
// teams are not our franchises, and mock-draft-data.ts skips team-less picks
// when building per-manager profiles while still keeping their prices as comps.
//
// Usage:
//   set -a; source .env; set +a
//   npx tsx scripts/import-external-auction.ts --file data/external-auctions/2026-siegel-league.json [--dry-run] [--replace]
//
// --dry-run resolves every name and prints the plan without writing. Run it
// first: an unresolved or ambiguous name is a silent data error otherwise.
// --replace deletes a previously imported auction with the same name and year
// before writing, so a corrected board can be re-imported.

import { readFileSync } from 'fs';
import PocketBase, { type RecordModel } from 'pocketbase';

const POCKETBASE_URL = process.env.POCKETBASE_URL || 'http://127.0.0.1:8090';
const WRITE_BATCH_SIZE = 25;

interface ExternalAuctionFile {
  name: string;
  year: number;
  source?: string;
  budget?: number;
  paidSlots?: number;
  teams: { column: number; label?: string; picks: [string, number][] }[];
}

interface CliArgs {
  file: string;
  dryRun: boolean;
  replace: boolean;
}

interface ResolvedPick {
  column: number;
  playerName: string;
  playerId: string;
  position: string;
  price: number;
  pickOrder: number;
}

function parseArgs(argv: string[]): CliArgs {
  let file = '';
  let dryRun = false;
  let replace = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') dryRun = true;
    else if (arg === '--replace') replace = true;
    else if (arg === '--file') file = argv[++i] ?? '';
    else throw new Error(`Unknown argument: "${arg}"`);
  }
  if (!file) throw new Error('--file is required (e.g. --file data/external-auctions/2026-siegel-league.json)');
  return { file, dryRun, replace };
}

// Names come off a hand-entered board, so they will not always match the
// rankings source byte for byte. Compare on a folded key: lowercase, no
// punctuation, no generational suffix.
function nameKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/\./g, '')
    .replace(/['’]/g, '')
    .replace(/\s+(jr|sr|ii|iii|iv|v)$/, '')
    .replace(/[^a-z0-9]/g, '');
}

// Validate the board before touching PocketBase: a column that does not add up
// is a transcription error, and importing it would quietly teach the model a
// wrong market. Columns are allowed to come in UNDER budget (a team can finish
// its roster with money left) but never over.
function checkBudget(file: ExternalAuctionFile): string[] {
  const budget = file.budget ?? 200;
  const paidSlots = file.paidSlots ?? 7;
  const problems: string[] = [];
  for (const team of file.teams) {
    const total = team.picks.reduce((sum, [, price]) => sum + price, 0);
    if (team.picks.length !== paidSlots) {
      problems.push(`column ${team.column}: ${team.picks.length} picks, expected ${paidSlots}`);
    }
    if (total > budget) {
      problems.push(`column ${team.column}: $${total} spent, over the $${budget} budget`);
    }
  }
  return problems;
}

async function resolvePlayers(
  pb: PocketBase,
  file: ExternalAuctionFile
): Promise<{ picks: ResolvedPick[]; unresolved: string[]; ambiguous: string[] }> {
  const players = await pb.collection('players').getFullList({ requestKey: null });

  // A folded key can collide (two "Michael Wilson"s). Keep every candidate and
  // disambiguate by who actually has a ranked season row for this year — the
  // model only ever prices ranked players, so an unranked namesake is wrong by
  // construction.
  const byKey = new Map<string, RecordModel[]>();
  for (const player of players) {
    const key = nameKey(String(player.name ?? ''));
    const bucket = byKey.get(key);
    if (bucket) bucket.push(player);
    else byKey.set(key, [player]);
  }

  const seasons = await pb.collection('player_seasons').getFullList({
    filter: `year = ${file.year}`,
    requestKey: null,
  });
  const rankedThisYear = new Set(
    seasons.filter((s) => Number(s.rank ?? 0) > 0).map((s) => String(s.player_id))
  );

  const picks: ResolvedPick[] = [];
  const unresolved: string[] = [];
  const ambiguous: string[] = [];
  let pickOrder = 1;

  for (const team of file.teams) {
    for (const [playerName, price] of team.picks) {
      const candidates = byKey.get(nameKey(playerName)) ?? [];
      let match: RecordModel | undefined;
      if (candidates.length === 1) {
        match = candidates[0];
      } else if (candidates.length > 1) {
        const ranked = candidates.filter((c) => rankedThisYear.has(c.id));
        if (ranked.length === 1) match = ranked[0];
        else {
          ambiguous.push(`${playerName} (${candidates.length} players share this name)`);
          continue;
        }
      }
      if (!match) {
        unresolved.push(playerName);
        continue;
      }
      picks.push({
        column: team.column,
        playerName,
        playerId: match.id,
        position: String(match.position ?? ''),
        price,
        pickOrder: pickOrder++,
      });
    }
  }

  return { picks, unresolved, ambiguous };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const file = JSON.parse(readFileSync(args.file, 'utf8')) as ExternalAuctionFile;

  const totalPicks = file.teams.reduce((sum, t) => sum + t.picks.length, 0);
  console.log(`file:  ${args.file}`);
  console.log(`board: "${file.name}" — ${file.year}, ${file.teams.length} teams, ${totalPicks} priced picks`);

  const budgetProblems = checkBudget(file);
  if (budgetProblems.length > 0) {
    console.error('\nbudget check failed:');
    for (const problem of budgetProblems) console.error(`  ${problem}`);
    throw new Error('Fix the board file before importing — a column that does not add up is a transcription error');
  }
  const spent = file.teams.reduce((sum, t) => sum + t.picks.reduce((s, [, p]) => s + p, 0), 0);
  const budget = (file.budget ?? 200) * file.teams.length;
  console.log(`budget: $${spent} of $${budget} spent across ${file.teams.length} teams\n`);

  const pb = new PocketBase(POCKETBASE_URL);
  const email = process.env.PB_SUPERUSER_EMAIL;
  const password = process.env.PB_SUPERUSER_PASSWORD;
  if (!email || !password) {
    throw new Error('PB_SUPERUSER_EMAIL and PB_SUPERUSER_PASSWORD are required');
  }
  await pb.collection('_superusers').authWithPassword(email, password);

  const { picks, unresolved, ambiguous } = await resolvePlayers(pb, file);
  console.log(`resolved: ${picks.length} of ${totalPicks} picks to players`);
  if (unresolved.length > 0) {
    console.log(`\nunresolved names (no player record):`);
    for (const name of unresolved) console.log(`  ${name}`);
  }
  if (ambiguous.length > 0) {
    console.log(`\nambiguous names (add the player, or disambiguate by hand):`);
    for (const name of ambiguous) console.log(`  ${name}`);
  }
  if (unresolved.length > 0 || ambiguous.length > 0) {
    console.log(
      '\nUnmatched picks are dropped from the import. They still count against ' +
        "their column's budget, so the remaining prices stay honest — but the model " +
        'loses those comps.'
    );
  }

  const byPosition = new Map<string, number>();
  for (const pick of picks) byPosition.set(pick.position, (byPosition.get(pick.position) ?? 0) + 1);
  console.log(
    `\nby position: ${[...byPosition.entries()].sort((a, b) => b[1] - a[1]).map(([p, n]) => `${p} ${n}`).join(', ')}`
  );

  const existing = await pb.collection('auctions').getFullList({
    filter: pb.filter('name = {:name} && year = {:year}', { name: file.name, year: file.year }),
    requestKey: null,
  });
  if (existing.length > 0 && !args.replace) {
    throw new Error(
      `An auction named "${file.name}" already exists for ${file.year}. ` +
        'Re-run with --replace to delete it and import again.'
    );
  }

  if (args.dryRun) {
    console.log('\n[dry-run] no writes performed');
    return;
  }

  // Deleting the auction cascades to its picks via the required auction_id
  // relation, so the picks do not need a separate sweep.
  for (const auction of existing) {
    await pb.collection('auctions').delete(auction.id, { requestKey: null });
    console.log(`\nreplaced: deleted existing auction ${auction.id}`);
  }

  // `external` is the marker everything downstream keys on: the API rules grant
  // read access on it (migration 1784380000), the UI filters on it, and the
  // value model discounts its rows by externalWeight. No `user` and no `league`
  // because there is no owner — but the flag, not the absent relations, is what
  // declares intent. `completed` is required for the model to synthesize $0
  // rows for ranked-but-undrafted players from this board.
  // Created ACTIVE, not completed. A completed board is taken at its word: every
  // ranked player it does not price becomes a $0 "nobody bid on him" observation.
  // So a half-written board is worse than no board — it would silently teach the
  // model that dozens of drafted players went for nothing. The auction is only
  // promoted to `completed` once every pick is in, and is deleted if any fails
  // (which matters most under --replace, where the previous good board is gone).
  const auction = await pb.collection('auctions').create(
    {
      name: file.name,
      year: file.year,
      status: 'active',
      type: 'official',
      external: true,
      sim: false,
      drafted_at: `${file.year}-08-01 00:00:00.000Z`,
    },
    { requestKey: null }
  );
  console.log(`\ncreated auction ${auction.id} (external — readable, never listed in the app)`);

  try {
    // pick_order is supplied explicitly: the draft_picks hook respects
    // superuser-provided values, and every pick here is priced, so the hook's
    // snake-turn enforcement does not apply.
    for (let i = 0; i < picks.length; i += WRITE_BATCH_SIZE) {
      await Promise.all(
        picks.slice(i, i + WRITE_BATCH_SIZE).map((pick) =>
          pb.collection('draft_picks').create(
            {
              auction_id: auction.id,
              player_id: pick.playerId,
              price: pick.price,
              pick_order: pick.pickOrder,
              drafted_at: `${file.year}-08-01 00:00:00.000Z`,
            },
            { requestKey: null }
          )
        )
      );
    }

    // Verify before publishing rather than trusting the writes: the count is the
    // one cheap check that the board the model will read is the board on paper.
    const written = await pb.collection('draft_picks').getFullList({
      filter: pb.filter('auction_id = {:id}', { id: auction.id }),
      requestKey: null,
    });
    if (written.length !== picks.length) {
      throw new Error(`wrote ${written.length} picks, expected ${picks.length}`);
    }

    await pb.collection('auctions').update(auction.id, { status: 'completed' }, { requestKey: null });
  } catch (error) {
    // Deleting the auction cascades to whatever picks did land.
    await pb.collection('auctions').delete(auction.id, { requestKey: null }).catch(() => {});
    throw new Error(
      `Import failed and was rolled back (auction ${auction.id} deleted): ` +
        (error instanceof Error ? error.message : String(error))
    );
  }
  console.log(`wrote ${picks.length} priced picks, auction marked completed`);
  console.log(
    `\nThis board now informs projected values from ${file.year} onward, discounted by ` +
      `the model's externalWeight. Rerun calc-projected-values.ts to apply it; pass ` +
      `--external-weight 0 to see the board priced as if it had never been imported.`
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
