'use client';

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Crown, Users } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { useLeagueContext } from '@/contexts/league-context';
import { useNavigation } from '@/contexts/navigation-context';
import { pb } from '@/lib/pb-client';
import type { DraftFormat } from '@/lib/roster';

const FORMAT_LABELS: Record<DraftFormat, string> = {
  auction: 'Auction',
  hybrid: 'Hybrid',
  snake: 'Snake',
};

export function LeagueLanding() {
  const { leagues, memberships } = useLeagueContext();
  const { selectLeague } = useNavigation();
  const userId = pb.authStore.record?.id ?? null;
  const leagueIds = useMemo(() => leagues.map(league => league.id).sort(), [leagues]);

  const { data: liveDraftCounts = {} } = useQuery({
    queryKey: ['league-live-draft-counts', leagueIds, userId],
    queryFn: async (): Promise<Record<string, number>> => {
      const params: Record<string, string | null> = { userId };
      const leagueFilter = leagueIds.map((leagueId, index) => {
        params[`league${index}`] = leagueId;
        return `league = {:league${index}}`;
      }).join(' || ');
      const records = await pb.collection('auctions').getFullList({
        filter: pb.filter(
          `status = "active" && external = false && (${leagueFilter}) && (type = "official" || user = {:userId})`,
          params,
        ),
      });
      const counts: Record<string, number> = {};

      for (const record of records) {
        counts[record.league] = (counts[record.league] ?? 0) + 1;
      }

      return counts;
    },
    enabled: leagueIds.length > 0,
  });

  const membershipByLeague = useMemo(
    () => new Map(memberships.map(membership => [membership.leagueId, membership])),
    [memberships],
  );

  return (
    <div className="min-h-full bg-gray-100 dark:bg-gray-900">
      <div className="mx-auto max-w-[1120px] px-4 py-10 max-md:py-6 sm:px-6 sm:pb-16">
        <div className="mb-8 max-w-[620px] sm:mb-[34px]">
          <div className="mb-2.5 text-[11px] font-bold tracking-[0.16em] text-gray-500">
            YOUR LEAGUES
          </div>
          <h1 className="text-balance text-[32px] font-extrabold leading-[1.1] tracking-[-0.02em] text-gray-900 dark:text-white max-md:text-[26px]">
            Choose a league
          </h1>
          <p className="mt-3 text-pretty text-[15.5px] leading-[1.55] text-gray-500 dark:text-gray-400">
            Pick the league whose draft room, teams, and settings you want to use.
          </p>
        </div>

        <div className="grid grid-cols-[repeat(auto-fill,minmax(min(340px,100%),1fr))] gap-4">
          {leagues.map(league => {
            const membership = membershipByLeague.get(league.id);
            const liveDraftCount = liveDraftCounts[league.id] ?? 0;
            const isCommissioner = league.commissioner === userId;

            return (
              <Card key={league.id} className="gap-0 rounded-[14px] py-0 shadow-sm">
                <CardContent className="flex h-full flex-col p-[22px]">
                  <div className="mb-4 flex flex-wrap items-center gap-2">
                    <Badge variant="secondary" className="font-bold">
                      {FORMAT_LABELS[league.settings.draftFormat]}
                    </Badge>
                    {isCommissioner && (
                      <Badge className="border-0 bg-blue-100 text-blue-700 hover:bg-blue-100 dark:bg-blue-950/60 dark:text-blue-400">
                        <Crown className="h-3.5 w-3.5" />
                        Commissioner
                      </Badge>
                    )}
                    {liveDraftCount > 0 && (
                      <Badge className="border-0 bg-emerald-100 text-emerald-700 hover:bg-emerald-100 dark:bg-emerald-950/60 dark:text-emerald-400">
                        {liveDraftCount} live
                      </Badge>
                    )}
                  </div>

                  <div className="text-xl font-bold tracking-[-0.01em] text-gray-900 dark:text-white">
                    {league.name}
                  </div>
                  <div className="mt-2 flex items-center gap-2 text-[13px] text-gray-500 dark:text-gray-400">
                    <Users className="h-4 w-4" />
                    {membership?.teamName ?? 'No team assigned'}
                  </div>

                  <Button
                    className="mt-6 h-[42px] w-full bg-neutral-900 text-sm font-bold hover:bg-neutral-700 dark:bg-white dark:text-gray-900 dark:hover:bg-gray-200"
                    onClick={() => selectLeague(league.id)}
                  >
                    Open league
                    <ArrowRight className="h-4 w-4" />
                  </Button>
                </CardContent>
              </Card>
            );
          })}
        </div>
      </div>
    </div>
  );
}
