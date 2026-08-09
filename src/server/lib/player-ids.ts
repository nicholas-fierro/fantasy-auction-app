// Shared matching of app players to their external provider IDs —
// `players.sleeper_id` / `espn_id` (headshots, injury badges) and
// `players.fantasypros_id` (the compare panel).
//
// Both the in-app "Sync player IDs" action (src/server/actions/imports.ts) and
// the CLI scripts (scripts/sync-player-images.ts,
// scripts/sync-fantasypros-ids.ts) import from here, so a player matched in the
// browser is the same player matched on the command line. The scripts keep their
// own disk caching, flags, and console reporting; only the matching lives here.
//
// A rankings import creates identity rows for new players with no provider IDs
// at all, which is why this has to run afterwards: without it a rookie has no
// headshot, no injury status, and a dead compare panel.

import Papa from 'papaparse';
import type PocketBase from 'pocketbase';
import type { RecordModel } from 'pocketbase';
import { normalizeName } from '@/server/lib/import-core';
import type { PlayerIdSyncReport } from '@/server/types/import';

export const SLEEPER_DUMP_URL = 'https://api.sleeper.app/v1/players/nfl';
// DynastyProcess ID map: fills espn_id for players where Sleeper's dump has
// none (it is missing espn_id for most 2022+ draft classes, which would force
// the UI onto Sleeper's unresized ~70-100KB JPEGs instead of ESPN's ~5-8KB
// combiner thumbnails).
export const DP_IDS_URL =
  'https://github.com/DynastyProcess/data/raw/master/files/db_playerids.csv';
// DynastyProcess/nflverse weekly rankings export, used for fantasypros_id. The
// FantasyPros free API truncates its player catalog (10 of 675 rows), so it is
// deliberately not used here.
export const DP_RANKINGS_URL =
  'https://raw.githubusercontent.com/dynastyprocess/data/master/files/db_fpecr_latest.csv';

// Only these positions are meaningfully matchable against roster spots;
// skip DEF/other Sleeper entries entirely (and app DST players separately).
const MATCHABLE_POSITIONS = new Set(['QB', 'RB', 'WR', 'TE', 'K', 'FB']);

// Sleeper positions folded into the app's position vocabulary (the app files
// fullbacks under RB).
export function canonicalPosition(position: string | null | undefined): string {
  const pos = (position ?? '').toUpperCase();
  return pos === 'FB' ? 'RB' : pos;
}

// App-name key -> Sleeper search key, for players whose common fantasy name
// differs from Sleeper's registered name. Keys are sleeperKey() output.
//
// `normalizeName` (import-core.ts) has its own alias table and runs first, so
// most entries below are now unreachable: it already folds "Ken Walker" ->
// "kenneth walker", "Gabriel Davis" -> "gabe davis", etc., and Sleeper
// registers those canonical spellings. Verified 2026-07-30 — the exception is
// `hollywoodbrown`, which is load-bearing: `normalizeName` canonicalizes
// *toward* "Hollywood Brown" while Sleeper registers him as "marquisebrown",
// so without this entry he does not match. The redundant entries are kept as
// insurance against `normalizeName`'s table changing underneath this one.
const NAME_ALIASES: Record<string, string> = {
  hollywoodbrown: 'marquisebrown',
  gabrieldavis: 'gabedavis',
  kenwalker: 'kennethwalker',
  joshpalmer: 'joshuapalmer',
  kennethgainwell: 'kennygainwell',
  chigoziemokonkwo: 'chigokonkwo',
};

export interface SleeperPlayerEntry {
  full_name?: string | null;
  search_full_name?: string | null;
  position?: string | null;
  team?: string | null;
  espn_id?: number | string | null;
  active?: boolean | null;
  status?: string | null;
}

export type SleeperDump = Record<string, SleeperPlayerEntry>;

export interface SleeperCandidate {
  sleeperId: string;
  entry: SleeperPlayerEntry;
}

// Sleeper-style key from an app player name: normalizeName() (lowercase,
// strip periods, drop Jr/Sr/II/III/IV/V), then strip everything but [a-z0-9]
// to match Sleeper's punctuation-free search_full_name.
export function sleeperKey(name: string): string {
  return normalizeName(name).replace(/[^a-z0-9]/g, '');
}

// Map from Sleeper-style search key -> candidate entries (any matchable
// position). Includes inactive players — the app DB holds historical
// players too.
export function buildSleeperIndex(dump: SleeperDump): Map<string, SleeperCandidate[]> {
  const index = new Map<string, SleeperCandidate[]>();
  for (const [sleeperId, entry] of Object.entries(dump)) {
    const position = (entry.position ?? '').toUpperCase();
    if (!MATCHABLE_POSITIONS.has(position)) continue;
    const key = entry.search_full_name ?? '';
    if (!key) continue;
    const list = index.get(key);
    if (list) list.push({ sleeperId, entry });
    else index.set(key, [{ sleeperId, entry }]);
  }
  return index;
}

// sleeper_id -> espn_id from the DynastyProcess ID map CSV.
export function parseDpEspnMap(csvText: string): Map<string, string> {
  const parsed = Papa.parse<Record<string, string>>(csvText, {
    header: true,
    skipEmptyLines: true,
  });
  const map = new Map<string, string>();
  for (const row of parsed.data) {
    const sleeperId = (row.sleeper_id ?? '').trim();
    const espnId = (row.espn_id ?? '').trim();
    if (sleeperId && espnId) map.set(sleeperId, espnId);
  }
  return map;
}

// --- FantasyPros ids -------------------------------------------------------

const fantasyProsKey = (name: string, position: string) =>
  `${normalizeName(name)}:${position.toUpperCase()}`;

interface DynastyProcessRanking {
  player?: string;
  id?: string;
  pos?: string;
}

// name:POS -> FantasyPros id, keeping only players whose rows agree on a single
// id (a name/position that maps to two ids is dropped, never guessed).
export function buildFantasyProsIdIndex(csvText: string): Map<string, string> {
  const parsed = Papa.parse<DynastyProcessRanking>(csvText, {
    header: true,
    skipEmptyLines: true,
  });
  if (parsed.errors.length) {
    throw new Error(`Unable to parse DynastyProcess rankings CSV: ${parsed.errors[0].message}`);
  }

  const idsByPlayer = new Map<string, Set<string>>();
  for (const row of parsed.data) {
    const id = String(row.id ?? '').trim();
    const name = String(row.player ?? '').trim();
    const position = String(row.pos ?? '').trim();
    if (!/^\d+$/.test(id) || !name || !position) continue;

    const mapKey = fantasyProsKey(name, position);
    const ids = idsByPlayer.get(mapKey) ?? new Set<string>();
    ids.add(id);
    idsByPlayer.set(mapKey, ids);
  }

  const index = new Map<string, string>();
  for (const [mapKey, ids] of idsByPlayer) {
    if (ids.size === 1) index.set(mapKey, [...ids][0]);
  }
  return index;
}

export function matchFantasyProsId(
  index: Map<string, string>,
  name: string,
  position: string
): string | null {
  return index.get(fantasyProsKey(name, position)) ?? null;
}

// --- Sleeper / ESPN matching ----------------------------------------------

export interface SleeperMatch {
  id: string; // players record id
  name: string;
  sleeperId: string;
  espnId: string;
  viaTeamTiebreak: boolean;
}

export interface SleeperMatchResult {
  matches: SleeperMatch[];
  // Players that already had a sleeper_id but no espn_id, filled from the
  // DynastyProcess map.
  espnBackfills: SleeperMatch[];
  ambiguous: { name: string; position: string; candidates: number }[];
  unmatched: { name: string; position: string }[];
  skippedDst: number;
  alreadyHadId: number;
  teamTiebreaks: number;
}

// player_id -> most recent team seen across player_seasons (newest year
// first). Used only as a tiebreaker for ambiguous Sleeper matches.
export async function loadLatestTeamByPlayer(pb: PocketBase): Promise<Map<string, string>> {
  const seasons = await pb.collection('player_seasons').getFullList({
    sort: '-year',
    requestKey: null,
  });
  const latestTeam = new Map<string, string>();
  for (const season of seasons) {
    const playerId = String(season.player_id ?? '');
    const team = String(season.team ?? '');
    if (playerId && team && !latestTeam.has(playerId)) {
      latestTeam.set(playerId, team);
    }
  }
  return latestTeam;
}

// Match app players against the Sleeper index. Candidates are narrowed by
// position; if more than one remains, the player's latest known team is the
// tiebreaker, then `active: true`. Still ambiguous -> reported and skipped,
// never guessed.
export function matchSleeperIds(
  players: readonly RecordModel[],
  index: Map<string, SleeperCandidate[]>,
  latestTeamByPlayer: Map<string, string>,
  dpEspnBySleeperId: Map<string, string>,
  force = false
): SleeperMatchResult {
  const result: SleeperMatchResult = {
    matches: [],
    espnBackfills: [],
    ambiguous: [],
    unmatched: [],
    skippedDst: 0,
    alreadyHadId: 0,
    teamTiebreaks: 0,
  };

  for (const player of players) {
    const name = String(player.name ?? '');
    const position = String(player.position ?? '').toUpperCase();

    if (position === 'DST') {
      result.skippedDst++;
      continue;
    }
    if (!force && String(player.sleeper_id ?? '') !== '') {
      result.alreadyHadId++;
      // Backfill espn_id for players matched on a previous run before the
      // DynastyProcess map was consulted (or newly added to it).
      if (String(player.espn_id ?? '') === '') {
        const dpEspn = dpEspnBySleeperId.get(String(player.sleeper_id)) ?? '';
        if (dpEspn) {
          result.espnBackfills.push({
            id: player.id,
            name,
            sleeperId: String(player.sleeper_id),
            espnId: dpEspn,
            viaTeamTiebreak: false,
          });
        }
      }
      continue;
    }

    const key = sleeperKey(name);
    const candidates = (index.get(NAME_ALIASES[key] ?? key) ?? []).filter(
      (candidate) => canonicalPosition(candidate.entry.position) === position
    );

    let chosen: SleeperCandidate | null = null;
    let viaTeamTiebreak = false;

    if (candidates.length === 1) {
      chosen = candidates[0];
    } else if (candidates.length > 1) {
      const latestTeam = (latestTeamByPlayer.get(player.id) ?? '').toUpperCase();
      const teamMatches = latestTeam
        ? candidates.filter((c) => (c.entry.team ?? '').toUpperCase() === latestTeam)
        : [];

      if (teamMatches.length === 1) {
        chosen = teamMatches[0];
        viaTeamTiebreak = true;
      } else {
        const activeMatches = (teamMatches.length > 0 ? teamMatches : candidates).filter(
          (c) => c.entry.active === true
        );
        if (activeMatches.length === 1) {
          chosen = activeMatches[0];
          viaTeamTiebreak = teamMatches.length === 1;
        } else {
          result.ambiguous.push({ name, position, candidates: candidates.length });
          continue;
        }
      }
    }

    if (!chosen) {
      result.unmatched.push({ name, position });
      continue;
    }

    if (viaTeamTiebreak) result.teamTiebreaks++;

    const espnIdRaw = chosen.entry.espn_id;
    const espnId =
      espnIdRaw != null ? String(espnIdRaw) : (dpEspnBySleeperId.get(chosen.sleeperId) ?? '');

    result.matches.push({
      id: player.id,
      name,
      sleeperId: chosen.sleeperId,
      espnId,
      viaTeamTiebreak,
    });
  }

  return result;
}

// --- In-app sync ----------------------------------------------------------

// Turn matches into per-player update payloads, writing only fields that are
// actually missing — which the card's copy promises and a blanket write would
// break in two ways:
//
//   1. A player with a blank `sleeper_id` but a real `espn_id` is still
//      re-matched, and `match.espnId` is `''` whenever neither Sleeper nor
//      DynastyProcess has a mapping. Writing that erases the good ID.
//   2. Overwriting an `espn_id` that is already set would discard a
//      hand-corrected value.
//
// `force` is the way to re-derive both. Even under `force` an empty id is
// never written, since blanking a column is not a re-derivation.
export function buildIdWrites(
  players: readonly RecordModel[],
  matches: readonly SleeperMatch[],
  force = false
): Map<string, Record<string, string>> {
  const playerById = new Map(players.map((player) => [player.id, player]));
  const writes = new Map<string, Record<string, string>>();

  for (const match of matches) {
    const current = playerById.get(match.id);
    const fields: Record<string, string> = {};
    if (match.sleeperId && (force || String(current?.sleeper_id ?? '') === '')) {
      fields.sleeper_id = match.sleeperId;
    }
    if (match.espnId && (force || String(current?.espn_id ?? '') === '')) {
      fields.espn_id = match.espnId;
    }
    if (Object.keys(fields).length > 0) writes.set(match.id, fields);
  }

  return writes;
}

async function fetchText(url: string, label: string): Promise<string> {
  const response = await fetch(url, {
    headers: { 'user-agent': 'fantasy-auction-app personal ID mapper' },
    cache: 'no-store',
  });
  if (!response.ok) {
    throw new Error(`${label} request failed (${response.status}).`);
  }
  return response.text();
}

// Fetch both provider sources, match every app player, and write the IDs that
// changed. `force` re-matches players that already have a sleeper_id /
// fantasypros_id; the default only fills in the blanks, which is the case that
// matters after a rankings import.
//
// No disk cache here (the CLI scripts have one). Each run re-downloads the
// sources, measured 2026-07-30: 324ms for all three (14.6MB Sleeper + 2.6MB +
// 1.1MB), 32ms to parse and index, 373ms end-to-end including the PocketBase
// round trips. Nowhere near a serverless timeout.
//
// ponytail: the one thing that does scale is the write loop — one sequential
// PB update per changed player. Steady-state that's a handful of rows; a
// first run against an empty database would be ~1,400. Batch it if that ever
// becomes the slow part.
export async function syncPlayerIdsCore(
  pb: PocketBase,
  { force = false }: { force?: boolean } = {}
): Promise<PlayerIdSyncReport> {
  const [sleeperText, dpIdsText, dpRankingsText] = await Promise.all([
    fetchText(SLEEPER_DUMP_URL, 'Sleeper player dump'),
    fetchText(DP_IDS_URL, 'DynastyProcess ID map'),
    fetchText(DP_RANKINGS_URL, 'DynastyProcess rankings'),
  ]);

  const sleeperIndex = buildSleeperIndex(JSON.parse(sleeperText) as SleeperDump);
  const dpEspnBySleeperId = parseDpEspnMap(dpIdsText);
  const fantasyProsIndex = buildFantasyProsIdIndex(dpRankingsText);

  const players = await pb.collection('players').getFullList({ requestKey: null });
  const latestTeamByPlayer = await loadLatestTeamByPlayer(pb);

  const sleeper = matchSleeperIds(
    players,
    sleeperIndex,
    latestTeamByPlayer,
    dpEspnBySleeperId,
    force
  );

  const writes = buildIdWrites(players, [...sleeper.matches, ...sleeper.espnBackfills], force);

  let fantasyProsMatched = 0;
  let fantasyProsUnmatched = 0;
  for (const player of players) {
    if (!force && String(player.fantasypros_id ?? '') !== '') continue;
    const id = matchFantasyProsId(
      fantasyProsIndex,
      String(player.name ?? ''),
      String(player.position ?? '')
    );
    if (!id) {
      fantasyProsUnmatched++;
      continue;
    }
    writes.set(player.id, { ...(writes.get(player.id) ?? {}), fantasypros_id: id });
    fantasyProsMatched++;
  }

  for (const [id, fields] of writes) {
    await pb.collection('players').update(id, fields, { requestKey: null });
  }

  return {
    playersScanned: players.length,
    sleeperMatched: sleeper.matches.length,
    espnBackfilled: sleeper.espnBackfills.length,
    fantasyProsMatched,
    fantasyProsUnmatched,
    written: writes.size,
    ambiguous: sleeper.ambiguous,
    unmatched: sleeper.unmatched,
  };
}
