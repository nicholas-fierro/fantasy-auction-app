'use client';

import { useQuery } from '@tanstack/react-query';
import { RecordModel } from 'pocketbase';
import { pb } from '@/lib/pb-client';
import { FantasyTeam } from '@/server/types/fantasy-team';
import { useAuction } from '@/contexts/auction-context';
import { useLeagueContext } from '@/contexts/league-context';

// auction_teams rows -> the FantasyTeam shape draft views consume (id = the
// fantasy team's id, ordered by the auction's draft_order).
function mapAuctionTeamRows(records: RecordModel[]): FantasyTeam[] {
  return records.map(record => ({
    id: record.expand?.fantasy_team_id?.id,
    name: record.expand?.fantasy_team_id?.name,
    draft_order: record.draft_order,
    created: record.expand?.fantasy_team_id?.created,
    updated: record.expand?.fantasy_team_id?.updated,
  }));
}

// The selected league's teams (draft_order here is the legacy global one).
// Only for contexts without a selected auction, e.g. seeding the new-auction dialog.
export function useAllFantasyTeams() {
  const { selectedLeagueId } = useLeagueContext();
  return useQuery({
    queryKey: ['fantasy-teams', selectedLeagueId],
    enabled: !!selectedLeagueId,
    queryFn: async () => {
      if (!selectedLeagueId) return [];
      const records = await pb.collection('fantasy_teams').getFullList({
        sort: 'draft_order',
        filter: pb.filter('league = {:leagueId}', { leagueId: selectedLeagueId }),
      });
      return records.map<FantasyTeam>(record => ({
        id: record.id,
        name: record.name,
        draft_order: record.draft_order,
        created: record.created,
        updated: record.updated,
      }));
    },
  });
}

// Teams in the selected auction's draft order — what draft views should use.
export function useAuctionTeams() {
  const { selectedAuctionId } = useAuction();

  return useQuery({
    queryKey: ['fantasy-teams', 'auction', selectedAuctionId],
    queryFn: async () => {
      const records = await pb.collection('auction_teams').getFullList({
        filter: pb.filter('auction_id = {:auctionId}', { auctionId: selectedAuctionId }),
        sort: 'draft_order',
        expand: 'fantasy_team_id',
      });
      return mapAuctionTeamRows(records);
    },
    enabled: !!selectedAuctionId,
  });
}
