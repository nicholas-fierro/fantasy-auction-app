// Pure, testable core for the CSV import flow. Every function takes a
// PocketBase client so it can be exercised directly with the SDK (the public
// server actions in `src/server/actions/imports.ts` wrap these behind
// `requireAuth()`). No Next.js / cookie dependencies live here.
//
// Ports the CLI scripts from ~/projects/fantasy-auction-data-import:
//   import-players.js / update-rankings.js / fix-position-data.js -> importRankingsCore
//   update-rookies.js                                             -> importRookiesCore
//   (new auction-values format)                                   -> importAuctionValuesCore
//
// `calculateProjectedValuesCore` no longer ports calculate-auction-values.js's
// linear curve — it runs the League Value Model, same as the offline CLI.

import Papa from 'papaparse';
import type PocketBase from 'pocketbase';
import type { RecordModel } from 'pocketbase';
import { computeAuctionEstimates } from '@/lib/value-model';
import {
  buildHistory,
  buildTargets,
  loadFromPocketBase,
  toValueTarget,
} from '@/server/lib/value-data';
import type {
  ImportReport,
  ImportInput,
  RankingImportCoreInput,
  RankingScoringFormat,
  CalculateProjectedResult,
} from '@/server/types/import';

// Write a few records at a time. PocketBase's SDK auto-cancels concurrent
// requests that share a key, so every write passes `{ requestKey: null }`.
const WRITE_BATCH_SIZE = 25;

// ---------------------------------------------------------------------------
// Field parsing helpers
// ---------------------------------------------------------------------------

// Parse an int from an untyped CSV cell, defaulting to 0 (mirrors the CLI
// scripts' `|| 0` idiom). Handles signed values like "+1" / "-2".
function toInt(value: unknown): number {
  const n = parseInt(String(value ?? '').trim(), 10);
  return Number.isNaN(n) ? 0 : n;
}

function toNumber(value: unknown): number {
  const n = parseFloat(String(value ?? '').replace(/[$,]/g, '').trim());
  return Number.isNaN(n) ? 0 : n;
}

// "3 out of 5 stars" -> 3 (regex from fix-position-data.js:27).
function parseSos(value: unknown): number {
  const match = String(value ?? '').match(/(\d+)\s+out\s+of\s+5\s+stars/i);
  return match ? parseInt(match[1], 10) : 0;
}

// "WR22" -> { basePosition: 'WR', positionRank: 22 } (regex from update-rankings.js:30).
function parsePos(value: unknown): { basePosition: string; positionRank: number } {
  const raw = String(value ?? '').trim();
  const basePosition = raw.replace(/[0-9]/g, '').trim().toUpperCase();
  const match = raw.match(/[A-Za-z]+(\d+)/);
  return { basePosition, positionRank: match ? parseInt(match[1], 10) : 0 };
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

// Historical ranking files use both registered and common names. Collapse the
// known variants that previously created duplicate player identities so reruns
// keep resolving to the repaired canonical row.
const PLAYER_NAME_ALIASES: Record<string, string> = {
  'ken walker': 'kenneth walker',
  'marquise brown': 'hollywood brown',
  'josh palmer': 'joshua palmer',
  'chigoziem okonkwo': 'chig okonkwo',
  'kenneth gainwell': 'kenny gainwell',
  'gabriel davis': 'gabe davis',
  'lamical perine': "la'mical perine",
  'zonovan knight': 'bam knight',
  'olabisi johnson': 'bisi johnson',
  'scott miller': 'scotty miller',
  "d'wayne eskridge": 'dee eskridge',
  'william fuller': 'will fuller',
  'steven hauschka': 'stephen hauschka',
  'benjamin watson': 'ben watson',
  'robbie anderson': 'robbie chosen',
  'robby anderson': 'robbie chosen',
  'mitch trubisky': 'mitchell trubisky',
  'deonte harris': 'deonte harty',
  'pj walker': 'phillip walker',
};

// Normalize a name for fuzzy matching: lowercase, strip periods, collapse
// whitespace, drop trailing generational suffixes (Jr/Sr/II/III/IV/V), then
// resolve known historical aliases.
export function normalizeName(name: string): string {
  const normalized = String(name ?? '')
    .toLowerCase()
    .replace(/\./g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\s+(jr|sr|ii|iii|iv|v)$/i, '')
    .trim();
  return PLAYER_NAME_ALIASES[normalized] ?? normalized;
}

export interface PlayerIndex {
  players: RecordModel[];
  byExactName: Map<string, RecordModel[]>;
  byNormName: Map<string, RecordModel[]>;
  latestTeamByPlayer: Map<string, string>;
  seasonByPlayer: Map<string, RecordModel>;
}

function pushMap(map: Map<string, RecordModel[]>, key: string, value: RecordModel): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

// Load every player identity + every season row up front (a few hundred rows).
// Avoids per-row filtered queries (also sidesteps filter-injection from names
// like `Ja'Marr Chase`). Season rows are sorted newest-first so the first one
// seen per player is that player's latest team (the only use of team here).
export async function loadPlayerIndex(pb: PocketBase, year: number): Promise<PlayerIndex> {
  const players = await pb.collection('players').getFullList({
    sort: 'name',
    requestKey: null,
  });
  const seasons = await pb.collection('player_seasons').getFullList({
    sort: '-year',
    requestKey: null,
  });

  const byExactName = new Map<string, RecordModel[]>();
  const byNormName = new Map<string, RecordModel[]>();
  for (const p of players) {
    pushMap(byExactName, String(p.name ?? '').trim(), p);
    pushMap(byNormName, normalizeName(String(p.name ?? '')), p);
  }

  const latestTeamByPlayer = new Map<string, string>();
  const seasonByPlayer = new Map<string, RecordModel>();
  for (const s of seasons) {
    if (s.team && !latestTeamByPlayer.has(s.player_id)) {
      latestTeamByPlayer.set(s.player_id, String(s.team));
    }
    if (s.year === year && !seasonByPlayer.has(s.player_id)) {
      seasonByPlayer.set(s.player_id, s);
    }
  }

  return { players, byExactName, byNormName, latestTeamByPlayer, seasonByPlayer };
}

type MatchResult =
  | { player: RecordModel; fuzzy?: boolean }
  | { player: null; ambiguous: number }
  | { player: null; ambiguous?: undefined };

// Match a CSV row to a player identity. Pass 1: exact name; pass 2: normalized
// name (marked `fuzzy: true` so callers can surface it for review).
// `basePosition` (when provided) narrows candidates. Team is never required —
// only a tiebreaker for otherwise-ambiguous matches, via the player's latest
// season team. Still ambiguous -> caller reports and skips.
export function matchPlayer(
  index: PlayerIndex,
  name: string,
  basePosition: string,
  team: string
): MatchResult {
  const wantPos = basePosition ? basePosition.toUpperCase() : '';
  const filterPos = (list: RecordModel[]): RecordModel[] =>
    wantPos ? list.filter((p) => String(p.position ?? '').toUpperCase() === wantPos) : list;

  let candidates = filterPos(index.byExactName.get(name.trim()) ?? []);
  let fuzzy = false;
  if (candidates.length === 0) {
    const normCandidates = filterPos(index.byNormName.get(normalizeName(name)) ?? []);
    // Dedupe by id (a player may appear under both exact & normalized keys).
    const seen = new Set<string>();
    candidates = normCandidates.filter((p) => (seen.has(p.id) ? false : seen.add(p.id)));
    fuzzy = true;
  }

  if (candidates.length === 1) return { player: candidates[0], fuzzy };
  if (candidates.length === 0) return { player: null };

  if (team) {
    const teamMatches = candidates.filter(
      (c) => (index.latestTeamByPlayer.get(c.id) ?? '').toUpperCase() === team.toUpperCase()
    );
    if (teamMatches.length === 1) return { player: teamMatches[0], fuzzy };
  }
  return { player: null, ambiguous: candidates.length };
}

// ---------------------------------------------------------------------------
// CSV parsing
// ---------------------------------------------------------------------------

type CsvRow = Record<string, unknown>;

function parseCsv(csvText: string): CsvRow[] {
  const { data } = Papa.parse<CsvRow>(csvText, {
    header: true,
    skipEmptyLines: true,
  });
  return data;
}

function getField(row: CsvRow, keys: string[]): string {
  for (const key of keys) {
    if (row[key] != null && String(row[key]).trim() !== '') return String(row[key]).trim();
  }
  return '';
}

async function runBatches<T>(items: T[], fn: (item: T) => Promise<unknown>): Promise<void> {
  for (let i = 0; i < items.length; i += WRITE_BATCH_SIZE) {
    const batch = items.slice(i, i + WRITE_BATCH_SIZE);
    await Promise.all(batch.map(fn));
  }
}

function emptyReport(): ImportReport {
  return { created: 0, updated: 0, skipped: 0, unmatched: [], ambiguous: [], fuzzy: [] };
}

// Register a freshly created identity into the index so later rows in the same
// file that reference the same player match it instead of creating a duplicate.
export function registerIdentity(index: PlayerIndex, record: RecordModel): void {
  pushMap(index.byExactName, String(record.name ?? '').trim(), record);
  pushMap(index.byNormName, normalizeName(String(record.name ?? '')), record);
}

// ---------------------------------------------------------------------------
// Rankings
// ---------------------------------------------------------------------------

// Upsert one `(player, year)` season row per CSV row with ranking fields.
// NEVER touches projected/actual/is_rookie on existing rows (a mid-season
// re-sync must not clobber those). Missing player identities are created.
// The season fields a rankings CSV row carries, restricted to the columns the
// CSV actually has.
//
// A column that is absent is left untouched rather than written as 0. Writing
// it would silently blank real data on every update: `sos` and `ecr_vs_adp` are
// missing from any partial export (and from the FantasyPros page's embedded
// `ecrData`), and both are displayed in the players table — `ecr_vs_adp` also
// feeds src/lib/draft-comparison.ts. A column that is present but has an empty
// cell still writes 0, which is a real value.
export function rankingFields(
  row: CsvRow,
  columns: Set<string>,
  scoringFormat: RankingScoringFormat = 'half'
): CsvRow {
  const fields: CsvRow = {};
  const has = (column: string) => columns.has(column);
  const rankingField = (field: string) => scoringFormat === 'ppr' ? `${field}_ppr` : field;

  if (has('TEAM')) fields.team = getField(row, ['TEAM']);
  if (has('POS')) fields[rankingField('position_rank')] = parsePos(getField(row, ['POS'])).positionRank;
  if (has('RK')) fields[rankingField('rank')] = toInt(row['RK']);
  if (has('TIERS')) fields[rankingField('tier')] = toInt(row['TIERS']);
  if (has('BYE WEEK')) fields.bye_week = toInt(row['BYE WEEK']);
  if (has('SOS SEASON')) fields.sos = parseSos(row['SOS SEASON']);
  if (has('ECR VS. ADP')) fields[rankingField('ecr_vs_adp')] = toInt(row['ECR VS. ADP']);

  return fields;
}

export async function importRankingsCore(
  pb: PocketBase,
  { year, csvText, scoringFormat }: RankingImportCoreInput
): Promise<ImportReport> {
  const rows = parseCsv(csvText);
  // Papa gives every row all header keys, so the first row's keys are the
  // CSV's column set. Only columns actually present are written — see
  // `rankingFields`.
  const columns = new Set(Object.keys(rows[0] ?? {}));
  const index = await loadPlayerIndex(pb, year);
  const report = emptyReport();

  const creates: CsvRow[] = [];
  const updates: { id: string; fields: CsvRow }[] = [];

  for (const row of rows) {
    const name = getField(row, ['PLAYER NAME', 'PLAYER']);
    if (!name) {
      report.skipped++;
      continue;
    }
    const team = getField(row, ['TEAM']);
    const posRaw = getField(row, ['POS']);
    const { basePosition } = parsePos(posRaw);

    const fields = rankingFields(row, columns, scoringFormat);

    const match = matchPlayer(index, name, basePosition, team);
    if (match.player === null && match.ambiguous) {
      report.ambiguous.push({ name, team, position: posRaw, matches: match.ambiguous });
      report.skipped++;
      continue;
    }

    let playerId: string;
    if (match.player) {
      playerId = match.player.id;
      if (match.fuzzy) {
        report.fuzzy.push({ csvName: name, matchedName: String(match.player.name ?? ''), position: posRaw });
      }
    } else {
      const identity = await pb
        .collection('players')
        .create({ name, position: basePosition }, { requestKey: null });
      registerIdentity(index, identity);
      playerId = identity.id;
    }

    const existing = index.seasonByPlayer.get(playerId);
    if (existing && existing.id !== '__pending__') {
      updates.push({ id: existing.id, fields });
    } else if (!existing) {
      creates.push({ player_id: playerId, year, ...fields });
      // Guard against duplicate CSV rows for the same new player.
      index.seasonByPlayer.set(playerId, { id: '__pending__', player_id: playerId, year } as unknown as RecordModel);
    } else {
      // Duplicate CSV row for a player whose season row is still pending.
      report.skipped++;
    }
  }

  await runBatches(creates, (c) =>
    pb.collection('player_seasons').create(c, { requestKey: null })
  );
  await runBatches(updates, (u) =>
    pb.collection('player_seasons').update(u.id, u.fields, { requestKey: null })
  );

  report.created = creates.length;
  report.updated = updates.length;
  return report;
}

// ---------------------------------------------------------------------------
// Rookies
// ---------------------------------------------------------------------------

// Flag `is_rookie` on the existing `(player, year)` season row. A player with
// no season row for the year is reported as unmatched ("import rankings first").
export async function importRookiesCore(
  pb: PocketBase,
  { year, csvText }: ImportInput
): Promise<ImportReport> {
  const rows = parseCsv(csvText);
  const index = await loadPlayerIndex(pb, year);
  const report = emptyReport();

  const updates: { id: string }[] = [];

  for (const row of rows) {
    const name = getField(row, ['PLAYER NAME', 'PLAYER']);
    if (!name) {
      report.skipped++;
      continue;
    }
    const team = getField(row, ['TEAM']);
    const posRaw = getField(row, ['POS']);
    const { basePosition } = parsePos(posRaw);

    const match = matchPlayer(index, name, basePosition, team);
    if (match.player === null && match.ambiguous) {
      report.ambiguous.push({ name, team, position: posRaw, matches: match.ambiguous });
      report.skipped++;
      continue;
    }
    if (!match.player) {
      report.unmatched.push({ name, team, position: posRaw });
      continue;
    }
    if (match.fuzzy) {
      report.fuzzy.push({ csvName: name, matchedName: String(match.player.name ?? ''), position: posRaw });
    }

    const season = index.seasonByPlayer.get(match.player.id);
    if (!season || season.id === '__pending__') {
      report.unmatched.push({ name, team, position: posRaw });
      continue;
    }
    updates.push({ id: season.id });
  }

  await runBatches(updates, (u) =>
    pb.collection('player_seasons').update(u.id, { is_rookie: true }, { requestKey: null })
  );

  report.updated = updates.length;
  return report;
}

// ---------------------------------------------------------------------------
// Auction values
// ---------------------------------------------------------------------------

// Detect the price column in a values CSV. Prefers an exact VALUE/AAV/PRICE
// header, then any header containing one of those tokens.
function findValueColumn(rows: CsvRow[]): string | null {
  if (rows.length === 0) return null;
  const headers = Object.keys(rows[0]);
  const tokens = ['VALUE', 'AAV', 'PRICE'];
  const exact = headers.find((h) => tokens.includes(h.trim().toUpperCase()));
  if (exact) return exact;
  return headers.find((h) => tokens.some((t) => h.toUpperCase().includes(t))) ?? null;
}

// Upsert `actual_auction_value` from a values CSV. Unknown historical players
// get a minimal season row (and identity, if needed) — no ranking fields.
export async function importAuctionValuesCore(
  pb: PocketBase,
  { year, csvText }: ImportInput
): Promise<ImportReport> {
  const rows = parseCsv(csvText);
  const index = await loadPlayerIndex(pb, year);
  const report = emptyReport();

  const valueColumn = findValueColumn(rows);
  if (!valueColumn) {
    // Nothing to import — surface every row as skipped rather than throwing.
    report.skipped = rows.length;
    return report;
  }

  const creates: CsvRow[] = [];
  const updates: { id: string; fields: CsvRow }[] = [];

  for (const row of rows) {
    const name = getField(row, ['PLAYER NAME', 'PLAYER']);
    if (!name) {
      report.skipped++;
      continue;
    }
    const team = getField(row, ['TEAM']);
    const posRaw = getField(row, ['POS']);
    const { basePosition } = parsePos(posRaw);
    const value = toNumber(row[valueColumn]);

    const match = matchPlayer(index, name, basePosition, team);
    if (match.player === null && match.ambiguous) {
      report.ambiguous.push({ name, team, position: posRaw, matches: match.ambiguous });
      report.skipped++;
      continue;
    }

    let playerId: string;
    if (match.player) {
      playerId = match.player.id;
      if (match.fuzzy) {
        report.fuzzy.push({ csvName: name, matchedName: String(match.player.name ?? ''), position: posRaw });
      }
    } else {
      const identity = await pb
        .collection('players')
        .create({ name, position: basePosition }, { requestKey: null });
      registerIdentity(index, identity);
      playerId = identity.id;
    }

    const existing = index.seasonByPlayer.get(playerId);
    if (existing && existing.id !== '__pending__') {
      updates.push({ id: existing.id, fields: { actual_auction_value: value } });
    } else if (!existing) {
      creates.push({ player_id: playerId, year, actual_auction_value: value });
      index.seasonByPlayer.set(playerId, { id: '__pending__', player_id: playerId, year } as unknown as RecordModel);
    } else {
      // Duplicate CSV row for a player whose season row is still pending.
      report.skipped++;
    }
  }

  await runBatches(creates, (c) =>
    pb.collection('player_seasons').create(c, { requestKey: null })
  );
  await runBatches(updates, (u) =>
    pb.collection('player_seasons').update(u.id, u.fields, { requestKey: null })
  );

  report.created = creates.length;
  report.updated = updates.length;
  return report;
}

// ---------------------------------------------------------------------------
// Projected-value recalculation (League Value Model)
// ---------------------------------------------------------------------------

// Recompute `projected_auction_value` for a year with the League Value Model —
// recency-weighted comps over this league's own official auction history,
// normalized to the league budget (docs/auction-value-model.md).
//
// This used to apply a linear rank -> price curve, which AD-15 warned to never
// press because it clobbered the model's offline output. Both paths now run the
// same code (./value-data.ts builders + computeAuctionEstimates), so the button
// and `scripts/calc-projected-values.ts` produce identical numbers and the
// warning no longer applies.
//
// Only rows whose value actually changes are written. Players with no comps get
// 0, same as the CLI.
export async function calculateProjectedValuesCore(
  pb: PocketBase,
  year: number
): Promise<CalculateProjectedResult> {
  const data = await loadFromPocketBase(pb);
  const history = buildHistory(data, year);
  const targets = buildTargets(data, year);

  if (history.length === 0) {
    throw new Error(
      `No official auction history before ${year} — nothing to price against.`
    );
  }

  const estimates = computeAuctionEstimates(history, targets.map(toValueTarget), year);

  const priced = targets
    .map((target) => ({ target, value: estimates.get(target.key) ?? 0 }))
    .sort((a, b) => b.value - a.value);

  const updates = priced.filter(({ target, value }) => value !== target.previous);

  await runBatches(updates, (u) =>
    pb
      .collection('player_seasons')
      .update(u.target.key, { projected_auction_value: u.value }, { requestKey: null })
  );

  return {
    updated: updates.length,
    unchanged: priced.length - updates.length,
    historyYears: [...new Set(history.map((row) => row.year))].sort((a, b) => a - b),
    top: priced.slice(0, 10).map(({ target, value }) => ({
      name: target.name,
      position: target.position,
      value,
      previous: target.previous,
    })),
  };
}
