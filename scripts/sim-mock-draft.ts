#!/usr/bin/env -S npx tsx
// Runs a whole draft through the real engine + snake AI, against the real computed
// team profiles and the real player board, then prints each team's roster shape and
// snake-pick sequence.
//
// This is the regression harness for AI drafting sanity. Unit tests check one pick
// in isolation, which is blind to anything that compounds across a draft — a flat
// depth weight once let a QB-biased team roster six quarterbacks, and only a full
// board showed it. Run this after touching snake-ai.ts, pricing.ts, or profiles.ts
// and read the position counts: QB/TE in the 1-3 range, K and DST exactly 1, RB/WR
// carrying the bench, and different teams leaning different ways.
//
// The auction phase is a stand-in (best available at a nominal price) — the point is
// the snake rounds and the roster shape they leave behind.
//
// Usage:
//   PB_SUPERUSER_EMAIL=... PB_SUPERUSER_PASSWORD=... \
//     npx tsx scripts/sim-mock-draft.ts [year]
import PocketBase from 'pocketbase';
import { computeTeamProfiles, type ProfilePick } from '@/lib/mock-draft/profiles';
import { buildTeamStates } from '@/lib/mock-draft/engine';
import { chooseSnakePick } from '@/lib/mock-draft/snake-ai';
import { DEFAULT_ROSTER_SETTINGS } from '@/lib/roster';
import type { DraftPickWithDetails } from '@/server/types/draft-pick';
import type { Player } from '@/server/types/player';
import { snakeSlotIndex } from '@/lib/snake-draft';

const pb = new PocketBase(process.env.POCKETBASE_URL || 'http://127.0.0.1:8090');
const YEAR = Number(process.argv[2] ?? 2026);
const RUN_WINDOW = 6;

async function main() {
  await pb
    .collection('_superusers')
    .authWithPassword(process.env.PB_SUPERUSER_EMAIL!, process.env.PB_SUPERUSER_PASSWORD!);

  const fantasyTeams = await pb.collection('fantasy_teams').getFullList({ requestKey: null });
  const auctions = await pb.collection('auctions').getFullList({
    filter: 'type = "official" && year > 0',
    requestKey: null,
  });

  // Real profiles, exactly as the hook builds them.
  const picksByTeam = new Map<string, ProfilePick[]>();
  for (const auction of auctions) {
    const year = auction.year as number;
    const [picks, seasons] = await Promise.all([
      pb.collection('draft_picks').getFullList({
        filter: `auction_id = "${auction.id}"`,
        expand: 'player_id',
        requestKey: null,
      }),
      pb.collection('player_seasons').getFullList({ filter: `year = ${year}`, requestKey: null }),
    ]);
    const seasonMap = new Map(seasons.map((s) => [s.player_id as string, s]));
    for (const pick of picks) {
      const p = pick.expand?.player_id;
      if (!p) continue;
      const s = seasonMap.get(pick.player_id as string);
      const teamId = pick.fantasy_team_id as string;
      const list = picksByTeam.get(teamId) ?? [];
      list.push({
        teamId,
        year,
        position: p.position,
        price: (pick.price as number) ?? 0,
        estimate: 0,
        pickOrder: (pick.pick_order as number) ?? 0,
        rank: (s?.rank as number) ?? 0,
        nflTeam: (s?.team as string) ?? '',
        isRookie: s?.is_rookie === true,
        rookieDataKnown: year >= 2019,
      });
      picksByTeam.set(teamId, list);
    }
  }
  const profiles = computeTeamProfiles(
    fantasyTeams.map((t) => t.id as string),
    picksByTeam
  );

  // The board for the sim year.
  const seasons = await pb
    .collection('player_seasons')
    .getFullList({ filter: `year = ${YEAR} && rank > 0`, expand: 'player_id', requestKey: null });
  const players: Player[] = seasons
    .map((s) => {
      const p = s.expand?.player_id;
      return {
        id: p?.id,
        name: p?.name,
        position: p?.position,
        team: (s.team as string) ?? '',
        rank: s.rank as number,
        position_rank: s.position_rank as number,
        is_rookie: s.is_rookie === true,
        projected_auction_value: s.projected_auction_value ?? null,
      } as Player;
    })
    .filter((p) => p.id && p.position)
    .sort((a, b) => a.rank - b.rank);

  const teams = fantasyTeams.map((t) => ({
    id: t.id as string,
    name: t.name as string,
    draft_order: t.draft_order as number,
    created: '',
    updated: '',
  }));
  teams.sort((a, b) => a.draft_order - b.draft_order);

  const settings = DEFAULT_ROSTER_SETTINGS;
  const paid = settings.paidAuctionSlots * teams.length;
  const rosterSize = settings.starterPositions.length + settings.benchSize;

  const picks: DraftPickWithDetails[] = [];
  const drafted = new Set<string>();

  // Auction phase stand-in: hand each team the best available in snake order at a
  // nominal price, just to seed realistic starting rosters before the snake rounds.
  for (let order = 1; order <= paid; order++) {
    const team = teams[snakeSlotIndex(order - 1, teams.length)];
    const player = players.find((p) => !drafted.has(p.id))!;
    drafted.add(player.id);
    picks.push({
      fantasy_team_id: team.id,
      player_id: player.id,
      price: 10,
      pick_order: order,
      player,
    } as unknown as DraftPickWithDetails);
  }

  // Snake phase through the real AI.
  for (let order = paid + 1; order <= rosterSize * teams.length; order++) {
    const team = teams[snakeSlotIndex(order - 1, teams.length)];
    const states = buildTeamStates(picks, teams, profiles, settings);
    const state = states.get(team.id)!;
    const available = players.filter((p) => !drafted.has(p.id));
    if (available.length === 0) break;
    const recent = picks.slice(-RUN_WINDOW).map((p) => p.player.position);
    const player = chooseSnakePick(state, available, 'sim', order, settings, recent);
    drafted.add(player.id);
    picks.push({
      fantasy_team_id: team.id,
      player_id: player.id,
      price: null,
      pick_order: order,
      player,
    } as unknown as DraftPickWithDetails);
  }

  console.log(`sim ${YEAR}: ${picks.length} picks over ${teams.length} teams\n`);
  const ORDER = ['QB', 'RB', 'WR', 'TE', 'K', 'DST'];
  for (const team of teams) {
    const mine = picks.filter((p) => p.fantasy_team_id === team.id);
    const counts: Record<string, number> = {};
    for (const p of mine) counts[p.player.position] = (counts[p.player.position] ?? 0) + 1;
    const snakeSeq = mine
      .filter((p) => p.pick_order > paid)
      .map((p) => p.player.position)
      .join(' ');
    console.log(
      `${team.name.padEnd(14)} ${ORDER.map((p) => `${p} ${counts[p] ?? 0}`).join('  ')}   | ${snakeSeq}`
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
