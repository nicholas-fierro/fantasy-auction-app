import { RecordModel } from 'pocketbase';
import { QueryClient } from '@tanstack/react-query';
import { pb } from '@/lib/pb-client';
import { Player, PlayerSeason } from '@/server/types/player';
import { DraftPickWithDetails } from '@/server/types/draft-pick';
import { WatchlistWithDetails } from '@/server/types/watchlist';
import { Auction } from '@/server/types/auction';
import { PlayerGameLog } from '@/server/types/player-game-log';
import type { GameLogStats, ScoringFormat } from '@/lib/fantasy-scoring';
import { seasonRankingValue } from '@/lib/season-rankings';

// Client-safe mapping logic shared by the direct-SDK read hooks. Ported verbatim
// from the (deleted) server actions so the returned shapes are byte-for-byte
// identical to what the components already consume. Nothing here may import
// 'next/headers' — it runs in the browser.

// Flatten a `player_seasons` record (with its `player_id` relation expanded) into
// the app-facing Player shape: identity from the expanded players record, stats
// from the season row.
export function mapSeasonToPlayer(
  record: RecordModel,
  scoringFormat: ScoringFormat
): Player {
  const p = record.expand?.player_id;
  return {
    id: p?.id ?? record.player_id,
    season_id: record.id,
    name: p?.name ?? '',
    team: record.team ?? '',
    position: p?.position ?? '',
    position_rank: seasonRankingValue(record, 'position_rank', scoringFormat),
    bye_week: record.bye_week,
    sos: record.sos,
    ecr_vs_adp: seasonRankingValue(record, 'ecr_vs_adp', scoringFormat),
    rank: seasonRankingValue(record, 'rank', scoringFormat),
    tier: seasonRankingValue(record, 'tier', scoringFormat),
    projected_auction_value: record.projected_auction_value > 0 ? record.projected_auction_value : null,
    is_rookie: record.is_rookie ?? false,
    gsis_id: p?.gsis_id || null,
    sleeper_id: p?.sleeper_id || null,
    espn_id: p?.espn_id || null,
    fantasypros_id: p?.fantasypros_id || null,
    created: p?.created ?? record.created,
    updated: p?.updated ?? record.updated,
  };
}

export function mapSeasonRecord(
  record: RecordModel,
  scoringFormat: ScoringFormat
): PlayerSeason {
  return {
    id: record.id,
    player_id: record.player_id,
    year: record.year,
    team: record.team ?? '',
    position_rank: seasonRankingValue(record, 'position_rank', scoringFormat),
    bye_week: record.bye_week,
    sos: record.sos,
    ecr_vs_adp: seasonRankingValue(record, 'ecr_vs_adp', scoringFormat),
    rank: seasonRankingValue(record, 'rank', scoringFormat),
    tier: seasonRankingValue(record, 'tier', scoringFormat),
    projected_auction_value: record.projected_auction_value > 0 ? record.projected_auction_value : null,
    actual_auction_value: record.actual_auction_value > 0 ? record.actual_auction_value : null,
    is_rookie: record.is_rookie ?? false,
    created: record.created,
    updated: record.updated,
  };
}

// One game's box score. `stats` is a JSON column, so PocketBase hands it back
// already parsed; the cast just names the shape. Scoring reads keys defensively
// (absent/null → 0), so no per-key normalization is needed here.
export function mapGameLogRecord(record: RecordModel): PlayerGameLog {
  return {
    id: record.id,
    player_id: record.player_id,
    season: record.season,
    week: record.week,
    season_type: record.season_type === 'POST' ? 'POST' : 'REG',
    game_id: record.game_id ?? '',
    team: record.team ?? '',
    opponent: record.opponent ?? '',
    stats: (record.stats ?? {}) as GameLogStats,
  };
}

// Merge the auction-year's per-season stats over the frozen fields on the
// expanded `players` record. `season` wins when present; otherwise fall back to
// the frozen fields so mock/future-year auctions still render team/bye/rank.
export function mapPickRecord(
  record: RecordModel,
  scoringFormat: ScoringFormat,
  season?: RecordModel
): DraftPickWithDetails {
  const p = record.expand?.player_id;
  return {
    id: record.id,
    auction_id: record.auction_id,
    fantasy_team_id: record.fantasy_team_id,
    player_id: record.player_id,
    pick_order: record.pick_order,
    price: record.price > 0 ? record.price : null,
    timestamp: record.drafted_at || record.timestamp,
    created: record.created,
    updated: record.updated,
    player: {
      id: p?.id,
      season_id: season?.id ?? '',
      name: p?.name,
      team: season?.team ?? p?.team,
      position: p?.position,
      position_rank: season
        ? seasonRankingValue(season, 'position_rank', scoringFormat)
        : p?.position_rank,
      bye_week: season?.bye_week ?? p?.bye_week,
      sos: season?.sos ?? p?.sos,
      ecr_vs_adp: season
        ? seasonRankingValue(season, 'ecr_vs_adp', scoringFormat)
        : p?.ecr_vs_adp,
      rank: season ? seasonRankingValue(season, 'rank', scoringFormat) : p?.rank,
      tier: season ? seasonRankingValue(season, 'tier', scoringFormat) : p?.tier,
      projected_auction_value: season
        ? (season.projected_auction_value > 0 ? season.projected_auction_value : null)
        : p?.projected_auction_value,
      is_rookie: season?.is_rookie ?? p?.is_rookie,
      gsis_id: p?.gsis_id || null,
      sleeper_id: p?.sleeper_id || null,
      espn_id: p?.espn_id || null,
      fantasypros_id: p?.fantasypros_id || null,
      created: p?.created,
      updated: p?.updated,
    },
    team: {
      id: record.expand?.fantasy_team_id?.id,
      name: record.expand?.fantasy_team_id?.name,
      draft_order: record.expand?.fantasy_team_id?.draft_order,
      created: record.expand?.fantasy_team_id?.created,
      updated: record.expand?.fantasy_team_id?.updated,
    },
  };
}

// Hydrate a watchlist record with the selected year's per-season stats layered
// over the expanded players record. Mirrors the shape getWatchlist returned.
export function mapWatchlistRecord(
  record: RecordModel,
  scoringFormat: ScoringFormat,
  season?: RecordModel
): WatchlistWithDetails {
  const p = record.expand?.player_id;
  return {
    id: record.id,
    user: record.user,
    player_id: record.player_id,
    watch_order: record.watch_order,
    // Absent or 0 both mean "no opinion" — an unset PocketBase number reads as 0,
    // and a market nudge of 0 would price the player at $1, which is never intended.
    market_nudge: record.market_nudge > 0 ? record.market_nudge : 1,
    created: record.created,
    updated: record.updated,
    player: {
      id: p?.id,
      season_id: season?.id ?? '',
      name: p?.name,
      team: season?.team ?? p?.team,
      position: p?.position,
      bye_week: season?.bye_week ?? p?.bye_week,
      rank: season ? seasonRankingValue(season, 'rank', scoringFormat) : p?.rank,
      tier: season ? seasonRankingValue(season, 'tier', scoringFormat) : p?.tier,
      position_rank: season
        ? seasonRankingValue(season, 'position_rank', scoringFormat)
        : p?.position_rank,
      sos: season?.sos ?? p?.sos,
      ecr_vs_adp: season
        ? seasonRankingValue(season, 'ecr_vs_adp', scoringFormat)
        : p?.ecr_vs_adp,
      projected_auction_value: season
        ? (season.projected_auction_value > 0 ? season.projected_auction_value : null)
        : p?.projected_auction_value,
      is_rookie: season?.is_rookie ?? p?.is_rookie,
      gsis_id: p?.gsis_id || null,
      sleeper_id: p?.sleeper_id || null,
      espn_id: p?.espn_id || null,
      fantasypros_id: p?.fantasypros_id || null,
      created: p?.created,
      updated: p?.updated,
    },
  };
}

export function mapAuctionRecord(record: RecordModel): Auction {
  return {
    id: record.id,
    name: record.name,
    year: record.year || null,
    type: record.type,
    sim: record.sim ?? false,
    status: record.status,
    user: record.user,
    league: record.league || null,
    external: record.external === true,
    drafted_at: record.drafted_at || record.created,
    created: record.created,
    updated: record.updated,
  };
}

// --- Shared season-rows query -------------------------------------------------
//
// Both the draft-picks and watchlist read hooks hydrate players from a given
// year's `player_seasons` rows. Instead of each refetching the whole table, they
// share a single TanStack query cached under this key (via
// queryClient.ensureQueryData), so one fetch per year serves both.

export const seasonRowsQueryKey = (year: number) => ['player-seasons', year] as const;

export async function fetchSeasonRowsForYear(year: number): Promise<RecordModel[]> {
  return pb.collection('player_seasons').getFullList({
    filter: pb.filter('year = {:year}', { year }),
    requestKey: null,
  });
}

export function seasonMapFromRows(rows: RecordModel[]): Map<string, RecordModel> {
  return new Map(rows.map((row) => [row.player_id as string, row]));
}

// Fetch (and cache) a year's player_seasons rows once, keyed by player_id. Both
// the draft-picks and watchlist hooks call this with the same year, so
// ensureQueryData de-dupes the fetch across them.
export async function ensureSeasonMap(
  queryClient: QueryClient,
  year: number
): Promise<Map<string, RecordModel>> {
  const rows = await queryClient.ensureQueryData({
    queryKey: seasonRowsQueryKey(year),
    queryFn: () => fetchSeasonRowsForYear(year),
  });
  return seasonMapFromRows(rows);
}
