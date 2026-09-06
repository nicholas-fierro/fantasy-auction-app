import type PocketBase from 'pocketbase';
import type { RecordModel } from 'pocketbase';
import { computeHistoricalValues } from '@/lib/history-client';
import { historyAuctionFilter, loadLeagueHistoryScope, selectHistoryAuctions, type HistoryAuction } from '@/lib/league-history';
import { buildHistoryIndex, estimateValue } from '@/lib/estimated-value';
import { computeTeamProfiles, type ProfilePick } from '@/lib/mock-draft/profiles';
import type { TeamProfile } from '@/lib/mock-draft/types';
import type { HistoricalValue } from '@/server/types/history';
import { seasonRankingValue } from '@/lib/season-rankings';

export async function loadTeamProfiles(
  client: PocketBase,
  leagueId: string,
  historicalValues?: HistoricalValue[]
): Promise<Map<string, TeamProfile>> {
  const scope = await loadLeagueHistoryScope(client, leagueId);
  const history = historicalValues ?? await computeHistoricalValues(leagueId, client);
  const index = buildHistoryIndex(history.filter((row) => !row.external));
  const [teams, auctions] = await Promise.all([
    client.collection('fantasy_teams').getFullList({
      filter: client.filter('league = {:leagueId}', { leagueId }), requestKey: null,
    }),
    client.collection('auctions').getFullList<RecordModel & HistoryAuction>({
      filter: historyAuctionFilter(client, scope, false), requestKey: null,
    }),
  ]);
  // Season rows are only consumed for the scoped auction years (plus every
  // earlier year, which establishes known veterans even when a rookie flag is
  // absent) — never the whole table.
  const maxYear = Math.max(0, ...selectHistoryAuctions(auctions, scope, false).map((auction) => auction.year));
  const seasons = maxYear > 0 ? await client.collection('player_seasons').getFullList({
    filter: client.filter('year <= {:maxYear}', { maxYear }), requestKey: null,
  }) : [];
  const teamIds = teams.filter((team) => team.league === leagueId).map((team) => team.id);
  const allowedTeams = new Set(teamIds);
  const seasonsByYear = new Map<number, Map<string, RecordModel>>();
  const firstSeasonYear = new Map<string, number>();
  for (const row of seasons) {
    const year = Number(row.year);
    const playerId = String(row.player_id);
    const forYear = seasonsByYear.get(year) ?? new Map<string, RecordModel>();
    forYear.set(playerId, row);
    seasonsByYear.set(year, forYear);
    firstSeasonYear.set(playerId, Math.min(firstSeasonYear.get(playerId) ?? year, year));
  }

  const picksByTeam = new Map<string, ProfilePick[]>();
  await Promise.all(selectHistoryAuctions(auctions, scope, false).map(async (auction) => {
    const year = Number(auction.year);
    const picks = await client.collection('draft_picks').getFullList({
      filter: client.filter('auction_id = {:auctionId}', { auctionId: auction.id }),
      expand: 'player_id', requestKey: null,
    });
    for (const pick of picks) {
      const teamId = String(pick.fantasy_team_id);
      const player = pick.expand?.player_id;
      if (!player || !allowedTeams.has(teamId)) continue;
      const playerId = String(pick.player_id);
      const season = seasonsByYear.get(year)?.get(playerId);
      // Profiles estimate against the same comp neighborhoods as history: a
      // missing season row means no rank, not rank 0 at the top of the board.
      if (!season) continue;
      const rank = seasonRankingValue(season, 'rank', scope.settings.scoringFormat);
      const positionRank = seasonRankingValue(season, 'position_rank', scope.settings.scoringFormat);
      const estimate = estimateValue(index, player.position, positionRank, rank, year);
      const isRookie = season?.is_rookie === true;
      const list = picksByTeam.get(teamId) ?? [];
      list.push({
        teamId, year, position: player.position,
        price: Number(pick.price ?? 0), estimate: estimate?.estimate ?? 0,
        pickOrder: Number(pick.pick_order ?? 0), rank,
        nflTeam: String(season?.team ?? ''), isRookie,
        rookieDataKnown: isRookie || (firstSeasonYear.get(playerId) ?? year) < year,
      });
      picksByTeam.set(teamId, list);
    }
  }));
  return computeTeamProfiles(teamIds, picksByTeam);
}
