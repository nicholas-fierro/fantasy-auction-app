// One PocketBase pass over the league's whole draft history, plus the headless
// draft loop the backtest and calibration scripts run against it.
//
// Server/script-only, the same as value-data.ts — it imports the PocketBase SDK
// and is never reachable from the browser. Everything it returns is plain data, so
// the scoring module next to it stays pure and testable.
//
// Why not value-data.ts: its RawPick is {auction_id, player_id, price} and it
// filters `price > 0`. Behavior work needs `fantasy_team_id`, `pick_order`, and
// the $0 snake picks, none of which survive that loader.
//
// HOLDOUT. `buildProfilesBefore(data, Y)` is the whole point: it builds the team
// profiles from picks before year Y only, so the sim for year Y has never seen
// year Y. The history index needs no such care — collectComps already drops rows
// with `row.year >= draftYear` — but buildHistoryIndexBefore filters anyway, so
// the guarantee is local instead of inherited.

import type PocketBase from 'pocketbase';
import type { RecordModel } from 'pocketbase';

import { buildHistoryIndex, estimateValue, type HistoryIndex } from '@/lib/estimated-value';
import { buildTeamStates, deriveMockDraftState } from '@/lib/mock-draft/engine';
import { chooseNomination } from '@/lib/mock-draft/nomination';
import { resolveNomination } from '@/lib/mock-draft/auction-resolver';
import { PARAMS, type MockDraftParams } from '@/lib/mock-draft/params';
import { computeBase, type MarketNudges } from '@/lib/mock-draft/pricing';
import {
  computeTeamProfiles,
  NEUTRAL_PROFILE,
  RUN_WINDOW,
  type ProfilePick,
} from '@/lib/mock-draft/profiles';
import { chooseSnakePick } from '@/lib/mock-draft/snake-ai';
import type { RankedPlayer, TeamProfile } from '@/lib/mock-draft/types';
import { DEFAULT_ROSTER_SETTINGS, type RosterSettings } from '@/lib/roster';
import type { DraftPickWithDetails } from '@/server/types/draft-pick';
import type { FantasyTeam } from '@/server/types/fantasy-team';
import type { HistoricalValue } from '@/server/types/history';
import type { Player } from '@/server/types/player';

// Positions the value model synthesizes $0 "nobody bid" rows for.
const SYNTHESIZABLE = new Set(['QB', 'RB', 'WR', 'TE']);

// One real historical pick, in the shape the scorer compares against.
// `price` is 0 for a snake pick.
export interface ActualPick {
  year: number;
  teamId: string;
  playerId: string;
  price: number;
  pickOrder: number;
  position: string;
  rank: number;
}

// A ProfilePick plus the two joins the estimate needs, kept alongside rather than
// on ProfilePick itself so the pure engine's type stays as it is.
export interface ProfileRow {
  pick: ProfilePick;
  playerId: string;
  positionRank: number;
}

export interface LeagueDraftData {
  teams: FantasyTeam[]; // sorted by draft_order
  // Every year's picks, priced and snake. `pick.estimate` is NOT filled here: it
  // depends on the holdout year, so buildProfilesBefore fills it.
  profileRows: ProfileRow[];
  historyRows: HistoricalValue[];
  seasonsByYear: Map<number, Map<string, RecordModel>>;
  actual: ActualPick[];
  // The years that have an official auction, ascending.
  auctionYears: number[];
  // Of those, the years whose official auction is FINISHED. Anything calibrating
  // against "what the league did" must use these: an active auction is a
  // part-drafted roster, and treating it as a complete one fits the parameters to
  // a draft that is still happening.
  completedYears: number[];
  // First year each player appears in player_seasons, for the rookie guard.
  firstSeasonYear: Map<string, number>;
}

// The league's roster shape changed: 16 rounds per team through 2024, 15 from
// 2025. Scoring the snake phase against an older draft with the current settings
// would leave a round unaccounted for.
export function settingsForYear(year: number): RosterSettings {
  return { ...DEFAULT_ROSTER_SETTINGS, benchSize: year <= 2024 ? 7 : 6 };
}

// --- Load --------------------------------------------------------------------

// `extraYears` adds player_seasons for years with no official auction, so a board
// can be built for a future draft (2026) as well as for a holdout year.
export async function loadLeagueDraftData(
  pb: PocketBase,
  extraYears: number[] = []
): Promise<LeagueDraftData> {
  const fantasyTeams = await pb.collection('fantasy_teams').getFullList({ requestKey: null });
  const auctions = await pb.collection('auctions').getFullList({
    filter: 'type = "official" && year > 0',
    requestKey: null,
  });

  const seasonsByYear = new Map<number, Map<string, RecordModel>>();
  const firstSeasonYear = new Map<string, number>();
  const profileRows: ProfileRow[] = [];
  const historyRows: HistoricalValue[] = [];
  const actual: ActualPick[] = [];

  const years = [...new Set(auctions.map((a) => a.year as number))].sort((a, b) => a - b);
  // A year counts as finished only when every official auction it has is
  // completed, so a year with a draft still in progress can never look done.
  const completedYears = years.filter((year) =>
    auctions.filter((a) => a.year === year).every((a) => a.status === 'completed')
  );
  const allYears = [...new Set([...years, ...extraYears])];

  for (const year of allYears) {
    const seasons = await pb.collection('player_seasons').getFullList({
      filter: `year = ${year}`,
      expand: 'player_id',
      requestKey: null,
    });
    const map = new Map<string, RecordModel>();
    for (const season of seasons) {
      const playerId = season.player_id as string;
      map.set(playerId, season);
      const earliest = firstSeasonYear.get(playerId);
      if (earliest === undefined || year < earliest) firstSeasonYear.set(playerId, year);
    }
    seasonsByYear.set(year, map);
  }

  for (const auction of auctions) {
    const year = auction.year as number;
    const seasonMap = seasonsByYear.get(year) ?? new Map<string, RecordModel>();
    const picks = await pb.collection('draft_picks').getFullList({
      filter: `auction_id = "${auction.id}"`,
      expand: 'player_id',
      requestKey: null,
    });
    const drafted = new Set<string>();

    for (const pick of picks) {
      const player = pick.expand?.player_id;
      if (!player) continue;
      const playerId = pick.player_id as string;
      const season = seasonMap.get(playerId);
      const teamId = pick.fantasy_team_id as string;
      const price = (pick.price as number) ?? 0;
      const rank = (season?.rank as number) ?? 0;

      profileRows.push({
        playerId,
        positionRank: (season?.position_rank as number) ?? 0,
        pick: {
          teamId,
          year,
          position: player.position,
          price,
          estimate: 0, // filled by buildProfilesBefore
          pickOrder: (pick.pick_order as number) ?? 0,
          rank,
          nflTeam: (season?.team as string) ?? '',
          isRookie: season?.is_rookie === true,
          // A `false` rookie flag is only trustworthy when an earlier season row
          // proves the player already existed. Resolved after the whole load.
          rookieDataKnown: false,
        },
      });

      actual.push({
        year,
        teamId,
        playerId,
        price,
        pickOrder: (pick.pick_order as number) ?? 0,
        position: player.position,
        rank,
      });

      // Mirrors history-client.ts: priced picks become 'official' comp rows.
      if (season && price > 0) {
        historyRows.push({
          year,
          player_id: playerId,
          name: player.name,
          position: player.position,
          rank,
          position_rank: (season.position_rank as number) ?? 0,
          price,
          source: 'official',
        });
        drafted.add(playerId);
      }
    }

    // ...and ranked-but-unsold QB/RB/WR/TE become $0 rows, so the weighted median
    // learns how often a ranked player simply doesn't get bid on.
    if (auction.status === 'completed') {
      for (const season of seasonMap.values()) {
        const playerId = season.player_id as string;
        if (drafted.has(playerId)) continue;
        const positionRank = (season.position_rank as number) ?? 0;
        if (positionRank <= 0) continue;
        const player = season.expand?.player_id;
        if (!player || !SYNTHESIZABLE.has(player.position)) continue;
        historyRows.push({
          year,
          player_id: playerId,
          name: player.name,
          position: player.position,
          rank: (season.rank as number) ?? 0,
          position_rank: positionRank,
          price: 0,
          source: 'undrafted',
        });
      }
    }
  }

  // The rookie guard needs every year loaded, so it resolves after the whole pass.
  for (const row of profileRows) {
    row.pick.rookieDataKnown =
      row.pick.isRookie || (firstSeasonYear.get(row.playerId) ?? row.pick.year) < row.pick.year;
  }

  const teams: FantasyTeam[] = fantasyTeams
    .map((t) => ({
      id: t.id as string,
      name: t.name as string,
      draft_order: t.draft_order as number,
      created: '',
      updated: '',
    }))
    .sort((a, b) => a.draft_order - b.draft_order) as FantasyTeam[];

  return {
    teams,
    profileRows,
    historyRows,
    seasonsByYear,
    actual,
    auctionYears: years,
    completedYears,
    firstSeasonYear,
  };
}

// --- Derive ------------------------------------------------------------------

// The comp index over the seasons before `beforeYear` (null = every year).
export function buildHistoryIndexBefore(
  data: LeagueDraftData,
  beforeYear: number | null
): HistoryIndex {
  const rows =
    beforeYear === null ? data.historyRows : data.historyRows.filter((r) => r.year < beforeYear);
  return buildHistoryIndex(rows);
}

// Team profiles from the picks before `beforeYear` (null = every year).
//
// `estimate` is filled here, not at load: aggression compares each historical
// price with the estimate available BEFORE that pick's own draft year, and that
// index itself must respect the holdout.
export function buildProfilesBefore(
  data: LeagueDraftData,
  beforeYear: number | null,
  params: MockDraftParams = PARAMS
): Map<string, TeamProfile> {
  const index = buildHistoryIndexBefore(data, beforeYear);
  const filtered = new Map<string, ProfilePick[]>();

  for (const { pick, positionRank } of data.profileRows) {
    if (beforeYear !== null && pick.year >= beforeYear) continue;
    const estimate = estimateValue(index, pick.position, positionRank, pick.rank, pick.year);
    const list = filtered.get(pick.teamId) ?? [];
    list.push({ ...pick, estimate: estimate?.estimate ?? 0 });
    filtered.set(pick.teamId, list);
  }

  return computeTeamProfiles(
    data.teams.map((t) => t.id),
    filtered,
    params
  );
}

// Every team gets the league-average profile. The null arm: if the sim scores the
// same here as with real profiles, the profile mechanism earns nothing.
export function neutralProfiles(data: LeagueDraftData): Map<string, TeamProfile> {
  return new Map(
    data.teams.map((t) => [
      t.id,
      { teamId: t.id, ...NEUTRAL_PROFILE, sampleSize: 0, snakeSampleSize: 0, affinitySampleSize: 0 },
    ])
  );
}

// Real profiles, moved to the wrong team ids by a fixed rotation. The sharper
// null: it keeps the between-manager variety and removes only the claim that a
// given profile belongs to a given manager.
export function shuffledProfiles(
  profiles: Map<string, TeamProfile>,
  teams: FantasyTeam[]
): Map<string, TeamProfile> {
  const ids = teams.map((t) => t.id);
  const shifted = new Map<string, TeamProfile>();
  for (let i = 0; i < ids.length; i++) {
    const source = profiles.get(ids[(i + 1) % ids.length]);
    if (source) shifted.set(ids[i], { ...source, teamId: ids[i] });
  }
  return shifted;
}

// The draftable board for one season.
export function buildBoard(data: LeagueDraftData, year: number): Player[] {
  const seasons = data.seasonsByYear.get(year);
  if (!seasons) return [];
  return [...seasons.values()]
    .filter((s) => ((s.rank as number) ?? 0) > 0)
    .map((s) => {
      const p = s.expand?.player_id;
      return {
        id: p?.id,
        name: p?.name,
        position: p?.position,
        team: (s.team as string) ?? '',
        rank: s.rank as number,
        position_rank: (s.position_rank as number) ?? 0,
        tier: (s.tier as number) ?? 0,
        is_rookie: s.is_rookie === true,
        projected_auction_value: s.projected_auction_value ?? null,
      } as Player;
    })
    .filter((p) => p.id && p.position)
    .sort((a, b) => a.rank - b.rank);
}

// --- Run ---------------------------------------------------------------------

export interface RunDraftOptions {
  auctionId: string;
  teams: FantasyTeam[];
  profiles: Map<string, TeamProfile>;
  players: Player[];
  index: HistoryIndex;
  year: number;
  settings?: RosterSettings;
  params?: MockDraftParams;
  // Manual per-player market multipliers, as the app passes them from the
  // watchlist. Absent means nobody has an opinion.
  nudges?: MarketNudges;
  // 'auction' stops after the paid slots; 'both' runs the snake rounds too.
  phases?: 'auction' | 'both';
}

// One whole draft with all 12 seats played by the AI, through the real engine.
// Deterministic: the entire seed surface is `auctionId` (see rng.ts).
export function runDraft(opts: RunDraftOptions): DraftPickWithDetails[] {
  const settings = opts.settings ?? settingsForYear(opts.year);
  const params = opts.params ?? PARAMS;
  const phases = opts.phases ?? 'both';
  const { auctionId, teams, profiles, players, index, year } = opts;

  const picks: DraftPickWithDetails[] = [];
  const drafted = new Set<string>();
  // Nominated but unsellable: every solvent team is already at its cap for the
  // position (see atAuctionPositionCap in pricing.ts). Treating that as the end of
  // the draft truncates rosters — it is a no-sale, so the player leaves the pool
  // and the same nominator picks someone else.
  const unsold = new Set<string>();

  // `computeBase` is pure in (index, year, player, auctionId), and the first three
  // are fixed for a run — so it is a pure function of the player here. Without this
  // the loop recomputes the whole board's comps at every pick: ~46,000 collectComps
  // calls per draft instead of ~550, which is the difference between a laptop-hours
  // calibration and a laptop-minutes one.
  const baseCache = new Map<string, number>();
  const baseOf = (player: Player): number => {
    const hit = baseCache.get(player.id);
    if (hit !== undefined) return hit;
    const value = computeBase(index, year, player, auctionId, params, opts.nudges);
    baseCache.set(player.id, value);
    return value;
  };

  for (;;) {
    const state = deriveMockDraftState(picks, teams, settings);
    if (state.phase === 'complete' || !state.currentTeamId) break;
    if (state.phase === 'snake' && phases === 'auction') break;

    const states = buildTeamStates(picks, teams, profiles, settings);
    const current = states.get(state.currentTeamId);
    if (!current) break;

    const available = players.filter((p) => !drafted.has(p.id));
    if (available.length === 0) break;

    if (state.phase === 'auction') {
      const sellable = available.filter((p) => !unsold.has(p.id));
      if (sellable.length === 0) break;
      const ranked: RankedPlayer[] = sellable.map((player) => ({
        player,
        base: baseOf(player),
      }));
      const choice = chooseNomination(
        current,
        ranked,
        auctionId,
        state.nextPickOrder,
        settings,
        params
      );
      const result = resolveNomination(
        choice.player,
        choice.base,
        [...states.values()],
        auctionId,
        state.nextPickOrder,
        settings,
        params
      );
      // No sale: every team is capped or broke on this player. Retire him from the
      // auction pool and let the same nominator try again — he stays draftable in
      // the snake rounds, which is where this league's backup QBs and TEs come from.
      if (!result.winnerTeamId) {
        unsold.add(choice.player.id);
        continue;
      }

      drafted.add(choice.player.id);
      picks.push({
        fantasy_team_id: result.winnerTeamId,
        player_id: choice.player.id,
        price: result.price,
        pick_order: state.nextPickOrder,
        player: choice.player,
      } as unknown as DraftPickWithDetails);
      continue;
    }

    const recent = picks.slice(-RUN_WINDOW).map((p) => p.player.position);
    const player = chooseSnakePick(
      current,
      available,
      auctionId,
      state.nextPickOrder,
      settings,
      recent,
      params
    );
    drafted.add(player.id);
    picks.push({
      fantasy_team_id: state.currentTeamId,
      player_id: player.id,
      price: null,
      pick_order: state.nextPickOrder,
      player,
    } as unknown as DraftPickWithDetails);
  }

  return picks;
}
