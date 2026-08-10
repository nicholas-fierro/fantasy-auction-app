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

// Positions the league bids on. Only these are synthesized as $0 undrafted rows.
const AUCTION_POSITIONS = new Set(['QB', 'RB', 'WR', 'TE']);

// Normalized source rows — identical shape from PocketBase or the JSON dump.
interface RawAuction {
  id: string;
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

// Load everything the builders need from PocketBase. Mirrors the collection
// filters the app uses (official auctions, priced picks) but leaves year
// filtering to the builders so a single fetch serves history and targets.
export async function loadFromPocketBase(pb: PocketBase): Promise<ValueData> {
  const auctionRecords = await pb.collection('auctions').getFullList({
    filter: pb.filter('type = "official" && year > 0'),
    requestKey: null,
  });
  const auctions: RawAuction[] = auctionRecords.map((a) => ({
    id: a.id,
    year: Number(a.year),
    status: String(a.status ?? ''),
    type: String(a.type ?? ''),
    external: a.external === true,
  }));

  const picks: RawPick[] = [];
  for (const auction of auctions) {
    const pickRecords = await pb.collection('draft_picks').getFullList({
      filter: pb.filter('auction_id = {:id} && price > 0', { id: auction.id }),
      requestKey: null,
    });
    for (const pick of pickRecords) {
      picks.push({
        auction_id: auction.id,
        player_id: String(pick.player_id),
        price: Number(pick.price),
      });
    }
  }

  const seasonRecords = await pb.collection('player_seasons').getFullList({ requestKey: null });
  const seasons: RawSeason[] = seasonRecords.map((s) => ({
    id: s.id,
    player_id: String(s.player_id),
    year: Number(s.year),
    rank: Number(s.rank ?? 0),
    position_rank: Number(s.position_rank ?? 0),
    projected_auction_value: Number(s.projected_auction_value ?? 0),
  }));

  const playerRecords = await pb.collection('players').getFullList({ requestKey: null });
  const players = new Map<string, RawPlayer>(
    playerRecords.map((p) => [p.id, { id: p.id, name: String(p.name ?? ''), position: String(p.position ?? '') }])
  );

  return { auctions, picks, seasons, players };
}

// Load the same shape from an offline JSON dump. The dump's picks are already
// filtered to official priced picks; numeric columns are numbers.
export function loadFromDump(path: string): ValueData {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as {
    auctions: RawAuction[];
    picks: RawPick[];
    seasons: RawSeason[];
    players: RawPlayer[];
  };
  return {
    auctions: raw.auctions.map((a) => ({
      id: a.id,
      year: Number(a.year),
      status: String(a.status ?? ''),
      type: String(a.type ?? ''),
      external: a.external === true,
    })),
    picks: raw.picks.map((p) => ({
      auction_id: p.auction_id,
      player_id: p.player_id,
      price: Number(p.price),
    })),
    seasons: raw.seasons.map((s) => ({
      id: s.id,
      player_id: s.player_id,
      year: Number(s.year),
      rank: Number(s.rank ?? 0),
      position_rank: Number(s.position_rank ?? 0),
      projected_auction_value: Number(s.projected_auction_value ?? 0),
    })),
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
  const seasonByPlayer = seasonIndex(data);
  const rows: HistoryRow[] = [];

  const years = [
    ...new Set(
      data.auctions
        .filter(
          (a) =>
            a.type === 'official' &&
            a.year > 0 &&
            // Prior years always. The draft year itself only from a finished
            // outside-league board: our own auction for that year has not
            // happened, and a part-drafted one would teach a truncated market.
            (a.year < beforeYear ||
              (a.year === beforeYear && a.external && a.status === 'completed'))
        )
        .map((a) => a.year)
    ),
  ];

  for (const year of years) {
    const yearAuctions = data.auctions.filter((a) => a.type === 'official' && a.year === year);
    const auctionIds = new Set(yearAuctions.map((a) => a.id));
    const externalIds = new Set(yearAuctions.filter((a) => a.external).map((a) => a.id));
    const completed = yearAuctions.filter((a) => a.status === 'completed');
    const hasCompleted = completed.length > 0;
    // If the only completed board for this year is someone else's, the "went
    // undrafted" claim is theirs too, and its rows are weighted as such.
    const undraftedIsExternal = completed.length > 0 && completed.every((a) => a.external);

    // Priced rows (unchanged construction): each official priced pick joined to
    // its year's rankings.
    const pricedPlayerIds = new Set<string>();
    for (const pick of data.picks) {
      if (!auctionIds.has(pick.auction_id) || !(pick.price > 0)) continue;
      pricedPlayerIds.add(pick.player_id);
      const season = seasonByPlayer.get(`${pick.player_id}:${year}`);
      rows.push({
        year,
        position: data.players.get(pick.player_id)?.position ?? '',
        position_rank: Number(season?.position_rank ?? 0),
        rank: Number(season?.rank ?? 0),
        price: pick.price,
        external: externalIds.has(pick.auction_id),
      });
    }

    // Synthesized $0 rows for ranked QB/RB/WR/TE who were not priced this year.
    if (!hasCompleted) continue;
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
        external: undraftedIsExternal,
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
