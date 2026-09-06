// Shared data loading for the League Value Model — used by the in-app
// recalculation (`calculateProjectedValuesCore` in ./import-core.ts), the CLI
// runner (scripts/calc-projected-values.ts), and the backtest
// (scripts/backtest-value-model.ts), so all three price off identical inputs.
// Both the live PocketBase and an offline JSON dump are normalized to the same
// in-memory shape (ValueData), then pure builders derive the model's inputs:
//
//   - buildHistory:     official-auction observations before a draft year,
//                       augmented with $0 rows for ranked-but-undrafted players
//                       (see the synthesis rule below);
//   - buildTargets:     a year's season rows to estimate / score;
//   - buildPricedPicks: a year's actually-priced picks (for backtest scoring).
//
// The $0 synthesis is the fix for the model over-valuing deep QBs/TEs: history
// used to contain only priced picks, so the model never learned that most
// ranked QBs/TEs go undrafted at $0. For each year that has a completed official
// auction, every ranked QB/RB/WR/TE season row whose player was NOT priced in
// any official auction that year becomes a price 0 observation. K/DST are never
// synthesized (no comps → no estimate, as before).

import { readFileSync } from 'fs';
import type PocketBase from 'pocketbase';
import type { HistoryRow, ValueTarget } from '@/lib/value-model';
import type { RecordModel } from 'pocketbase';
import { mapLeagueRecord } from '@/lib/league';
import {
  historyAuctionFilter,
  loadLeagueHistoryScope,
  requireLeagueId,
  selectHistoryAuctions,
  type LeagueHistoryScope,
} from '@/lib/league-history';
import type { ScoringFormat } from '@/lib/fantasy-scoring';
import { seasonRankingValue } from '@/lib/season-rankings';

// Positions the league bids on. Only these are synthesized as $0 undrafted rows.
const AUCTION_POSITIONS = new Set(['QB', 'RB', 'WR', 'TE']);

// Normalized source rows — identical shape from PocketBase or the JSON dump.
interface RawAuction {
  id: string;
  league: string;
  created: string;
  year: number;
  status: string;
  type: string;
  external: boolean;
}
interface RawPick {
  auction_id: string;
  player_id: string;
  price: number;
}
interface RawSeason {
  id: string;
  player_id: string;
  year: number;
  rank: number;
  position_rank: number;
  projected_auction_value: number;
}
interface RawPlayer {
  id: string;
  name: string;
  position: string;
}

export interface ValueData {
  scope: LeagueHistoryScope;
  auctions: RawAuction[];
  picks: RawPick[]; // official priced picks only (price > 0)
  seasons: RawSeason[];
  players: Map<string, RawPlayer>;
}

// A season row to estimate/score, carrying the identifiers the runner and
// backtest need (record id for writes, player_id to join to priced picks).
export interface TargetRow {
  key: string; // player_seasons record id
  player_id: string;
  name: string;
  position: string;
  position_rank: number;
  rank: number;
  previous: number; // existing projected_auction_value
}

// One actually-priced pick of a given year, joined to that year's rankings.
export interface PricedPick {
  player_id: string;
  position: string;
  position_rank: number;
  rank: number;
  price: number;
}

// --- Sources -------------------------------------------------------------

function assertScoringFormat(scope: LeagueHistoryScope, scoringFormat?: ScoringFormat): void {
  if (scoringFormat && scoringFormat !== scope.settings.scoringFormat) {
    throw new Error(`Selected league uses ${scope.settings.scoringFormat}, not ${scoringFormat}`);
  }
}

function normalizeAuction(row: RecordModel): RawAuction {
  return {
    id: row.id,
    league: String(row.league ?? ''),
    created: String(row.created ?? ''),
    year: Number(row.year),
    status: String(row.status ?? ''),
    type: String(row.type ?? ''),
    external: row.external === true,
  };
}

function normalizeSeason(row: RecordModel, scoringFormat: ScoringFormat): RawSeason {
  return {
    id: row.id,
    player_id: String(row.player_id),
    year: Number(row.year),
    rank: seasonRankingValue(row, 'rank', scoringFormat),
    position_rank: seasonRankingValue(row, 'position_rank', scoringFormat),
    projected_auction_value: Number(row.projected_auction_value ?? 0),
  };
}

export async function loadFromPocketBase(
  pb: PocketBase,
  options: { leagueId: string; scoringFormat?: ScoringFormat }
): Promise<ValueData> {
  const scope = await loadLeagueHistoryScope(pb, options.leagueId);
  assertScoringFormat(scope, options.scoringFormat);
  const auctionRecords = await pb.collection('auctions').getFullList({
    filter: historyAuctionFilter(pb, scope),
    requestKey: null,
  });
  const auctions = selectHistoryAuctions(auctionRecords.map(normalizeAuction), scope);
  const picks: RawPick[] = [];
  for (const auction of auctions) {
    const records = await pb.collection('draft_picks').getFullList({
      filter: pb.filter('auction_id = {:id} && price > 0', { id: auction.id }),
      requestKey: null,
    });
    for (const pick of records) {
      picks.push({ auction_id: auction.id, player_id: String(pick.player_id), price: Number(pick.price) });
    }
  }
  const [seasonRecords, playerRecords] = await Promise.all([
    pb.collection('player_seasons').getFullList({ requestKey: null }),
    pb.collection('players').getFullList({ requestKey: null }),
  ]);
  return {
    scope,
    auctions,
    picks,
    seasons: seasonRecords.map((row) => normalizeSeason(row, scope.settings.scoringFormat)),
    players: new Map(playerRecords.map((p) => [p.id, {
      id: p.id, name: String(p.name ?? ''), position: String(p.position ?? ''),
    }])),
  };
}

// Offline dumps may span leagues; apply the same board selection as live reads.
export function loadFromDump(
  path: string,
  options: { leagueId: string; scoringFormat?: ScoringFormat }
): ValueData {
  requireLeagueId(options.leagueId);
  const raw = JSON.parse(readFileSync(path, 'utf8')) as {
    leagues?: RecordModel[];
    fantasy_teams?: RecordModel[];
    auctions: RecordModel[];
    picks: RawPick[];
    seasons: RecordModel[];
    players: RawPlayer[];
  };
  const league = raw.leagues?.find((row) => row.id === options.leagueId);
  if (!league || !Array.isArray(raw.fantasy_teams)) {
    throw new Error('The dump must include the selected league and fantasy_teams metadata');
  }
  const scope: LeagueHistoryScope = {
    leagueId: options.leagueId,
    settings: mapLeagueRecord(league).settings,
    teamCount: raw.fantasy_teams.filter((team) => team.league === options.leagueId).length,
  };
  assertScoringFormat(scope, options.scoringFormat);
  const auctions = selectHistoryAuctions(raw.auctions.map(normalizeAuction), scope);
  const auctionIds = new Set(auctions.map((auction) => auction.id));
  return {
    scope,
    auctions,
    picks: raw.picks.filter((pick) => auctionIds.has(pick.auction_id) && Number(pick.price) > 0)
      .map((pick) => ({ ...pick, price: Number(pick.price) })),
    seasons: raw.seasons.map((row) => normalizeSeason(row, scope.settings.scoringFormat)),
    players: new Map(raw.players.map((p) => [p.id, { id: p.id, name: p.name, position: p.position }])),
  };
}

// --- Builders ------------------------------------------------------------

function seasonIndex(data: ValueData): Map<string, RawSeason> {
  // player_id:year -> season row.
  return new Map(data.seasons.map((s) => [`${s.player_id}:${s.year}`, s]));
}

// Official priced picks of a single year, joined to that year's rankings.
// External boards are excluded: this is the backtest's answer key, and scoring
// our model against another league's prices would be measuring the wrong room.
export function buildPricedPicks(data: ValueData, year: number): PricedPick[] {
  if (data.scope.settings.draftFormat === 'snake') return [];
  const auctionIds = new Set(
    data.auctions
      .filter((a) => a.type === 'official' && a.year === year && !a.external)
      .map((a) => a.id)
  );
  const seasonByPlayer = seasonIndex(data);
  const picks: PricedPick[] = [];
  for (const pick of data.picks) {
    if (!auctionIds.has(pick.auction_id) || !(pick.price > 0)) continue;
    const season = seasonByPlayer.get(`${pick.player_id}:${year}`);
    picks.push({
      player_id: pick.player_id,
      position: data.players.get(pick.player_id)?.position ?? '',
      position_rank: Number(season?.position_rank ?? 0),
      rank: Number(season?.rank ?? 0),
      price: pick.price,
    });
  }
  return picks;
}

// History for estimating draft year `beforeYear`: every official priced pick
// from earlier years, plus a synthesized $0 row for each ranked-but-undrafted
// QB/RB/WR/TE (see the synthesis rule at the top of this file).
//
// Rows from an outside league's imported board are marked `external`, and a
// completed external board for `beforeYear` ITSELF is included — it is the only
// same-year market evidence that can exist, since our own auction for the year
// being priced has not happened. Those rows are discounted by
// `ValueModelConfig.externalWeight` in collectComps, not here: this builder
// states where a row came from, the model decides what it is worth.
export function buildHistory(data: ValueData, beforeYear: number): HistoryRow[] {
  if (data.scope.settings.draftFormat === 'snake') return [];
  const seasonByPlayer = seasonIndex(data);
  const rows: HistoryRow[] = [];

  // Each eligible auction is its own observation of a market, so rows are built
  // PER BOARD rather than pooled by year. Pooling was wrong in two ways when a
  // year holds more than one board: a player bought in either one suppressed the
  // $0 "went undrafted" row for both, and during our own live draft the picks
  // already entered suppressed the external board's $0 rows — silently shifting
  // estimates as the draft progressed, even though collectComps rejects those
  // same-year league picks as comps.
  const eligible = data.auctions.filter(
    (a) =>
      a.type === 'official' &&
      a.year > 0 &&
      // Prior years always. The draft year itself only from a finished
      // outside-league board: our own auction for that year has not
      // happened, and a part-drafted one would teach a truncated market.
      (a.year < beforeYear || (a.year === beforeYear && a.external && a.status === 'completed'))
  );

  for (const auction of eligible) {
    const year = auction.year;
    const pricedPlayerIds = new Set<string>();
    for (const pick of data.picks) {
      if (pick.auction_id !== auction.id || !(pick.price > 0)) continue;
      pricedPlayerIds.add(pick.player_id);
      const season = seasonByPlayer.get(`${pick.player_id}:${year}`);
      rows.push({
        year,
        position: data.players.get(pick.player_id)?.position ?? '',
        position_rank: Number(season?.position_rank ?? 0),
        rank: Number(season?.rank ?? 0),
        price: pick.price,
        external: auction.external,
      });
    }

    // Synthesized $0 rows for ranked QB/RB/WR/TE this board did not price. The
    // claim "nobody bid on him" belongs to the board making it, so the rows
    // inherit that board's provenance.
    if (auction.status !== 'completed') continue;
    for (const season of data.seasons) {
      if (season.year !== year || season.position_rank <= 0) continue;
      if (pricedPlayerIds.has(season.player_id)) continue;
      const position = data.players.get(season.player_id)?.position ?? '';
      if (!AUCTION_POSITIONS.has(position)) continue;
      rows.push({
        year,
        position,
        position_rank: season.position_rank,
        rank: season.rank,
        price: 0,
        external: auction.external,
      });
    }
  }

  return rows;
}

// A year's season rows as estimation/scoring targets.
export function buildTargets(data: ValueData, year: number): TargetRow[] {
  const targets: TargetRow[] = [];
  for (const season of data.seasons) {
    if (season.year !== year) continue;
    const player = data.players.get(season.player_id);
    targets.push({
      key: season.id,
      player_id: season.player_id,
      name: player?.name ?? '?',
      position: player?.position ?? '?',
      position_rank: season.position_rank,
      rank: season.rank,
      previous: season.projected_auction_value,
    });
  }
  return targets;
}

// The model's ValueTarget view of a TargetRow.
export function toValueTarget(t: TargetRow): ValueTarget {
  return { key: t.key, position: t.position, position_rank: t.position_rank, rank: t.rank };
}
