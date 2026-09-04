'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { useQuery } from '@tanstack/react-query';
import type { RecordModel } from 'pocketbase';
import { pb } from '@/lib/pb-client';
import {
  mapLeagueRecord,
  resolveSelectedLeagueId,
  type LeagueInfo,
  type LeagueMembership,
} from '@/lib/league';
import {
  DEFAULT_ROSTER_SETTINGS,
  type DraftFormat,
  type RosterSettings,
} from '@/lib/roster';

const SELECTED_LEAGUE_KEY = 'selected-league-id';

interface LeagueQueryData {
  memberships: LeagueMembership[];
  leagues: LeagueInfo[];
}

interface LeagueContextType {
  memberships: LeagueMembership[];
  leagues: LeagueInfo[];
  selectedLeagueId: string | null;
  setSelectedLeagueId: (id: string | null) => void;
  selectedLeague: LeagueInfo | null;
  selectedMembership: LeagueMembership | null;
  settings: RosterSettings;
  format: DraftFormat;
  isCommissioner: boolean;
  isLoading: boolean;
}

const LeagueContext = createContext<LeagueContextType | undefined>(undefined);
const EMPTY_MEMBERSHIPS: LeagueMembership[] = [];
const EMPTY_LEAGUES: LeagueInfo[] = [];

function mapMembershipRecords(records: RecordModel[]): LeagueQueryData {
  const leaguesById = new Map<string, LeagueInfo>();
  const memberships: LeagueMembership[] = [];

  for (const record of records) {
    const leagueRecord = record.expand?.league as RecordModel | undefined;
    if (!leagueRecord) continue;

    const league = mapLeagueRecord(leagueRecord);
    const teamRecord = record.expand?.fantasy_team as RecordModel | undefined;
    leaguesById.set(league.id, league);
    memberships.push({
      id: record.id,
      leagueId: record.league,
      userId: record.user,
      fantasyTeamId: record.fantasy_team || null,
      teamName: teamRecord?.name || null,
    });
  }

  memberships.sort((a, b) => {
    const left = leaguesById.get(a.leagueId)?.name ?? '';
    const right = leaguesById.get(b.leagueId)?.name ?? '';
    return left.localeCompare(right);
  });

  return {
    memberships,
    leagues: memberships
      .map(membership => leaguesById.get(membership.leagueId))
      .filter((league): league is LeagueInfo => !!league),
  };
}

function writeSelectedLeague(id: string | null) {
  try {
    if (id) localStorage.setItem(SELECTED_LEAGUE_KEY, id);
    else localStorage.removeItem(SELECTED_LEAGUE_KEY);
  } catch {
    // Storage can be unavailable in privacy-restricted browser contexts.
  }
}

export function LeagueProvider({ children }: { children: ReactNode }) {
  const userId = pb.authStore.record?.id ?? null;
  const [selectedLeagueId, setSelectedLeagueState] = useState<string | null>(null);
  const [selectionRestored, setSelectionRestored] = useState(false);
  const [selectionResolved, setSelectionResolved] = useState(false);

  useEffect(() => {
    let saved: string | null = null;
    try {
      saved = localStorage.getItem(SELECTED_LEAGUE_KEY);
    } catch {
      // Storage can be unavailable in privacy-restricted browser contexts.
    }
    setSelectedLeagueState(saved);
    setSelectionRestored(true);
  }, []);

  const { data, isLoading: membershipsLoading } = useQuery({
    queryKey: ['league-memberships', userId],
    queryFn: async (): Promise<LeagueQueryData> => {
      const records = await pb.collection('league_members').getFullList({
        filter: pb.filter('user = {:userId}', { userId }),
        expand: 'league,fantasy_team',
      });
      return mapMembershipRecords(records);
    },
    enabled: !!userId,
    staleTime: 5 * 60 * 1000,
  });

  const memberships = data?.memberships ?? EMPTY_MEMBERSHIPS;
  const leagues = data?.leagues ?? EMPTY_LEAGUES;

  useEffect(() => {
    if (!selectionRestored || membershipsLoading) return;

    const resolvedId = resolveSelectedLeagueId(memberships, selectedLeagueId);
    if (resolvedId !== selectedLeagueId) {
      setSelectedLeagueState(resolvedId);
      writeSelectedLeague(resolvedId);
    }
    setSelectionResolved(true);
  }, [memberships, membershipsLoading, selectedLeagueId, selectionRestored]);

  const setSelectedLeagueId = useCallback((id: string | null) => {
    setSelectedLeagueState(id);
    setSelectionResolved(true);
    writeSelectedLeague(id);
  }, []);

  const selectedLeague = leagues.find(league => league.id === selectedLeagueId) ?? null;
  const selectedMembership =
    memberships.find(membership => membership.leagueId === selectedLeagueId) ?? null;
  const settings = selectedLeague?.settings ?? DEFAULT_ROSTER_SETTINGS;
  const isCommissioner = !!selectedLeague && selectedLeague.commissioner === userId;

  const value = useMemo(() => ({
    memberships,
    leagues,
    selectedLeagueId,
    setSelectedLeagueId,
    selectedLeague,
    selectedMembership,
    settings,
    format: settings.draftFormat,
    isCommissioner,
    isLoading: membershipsLoading || !selectionResolved,
  }), [
    memberships,
    leagues,
    selectedLeagueId,
    setSelectedLeagueId,
    selectedLeague,
    selectedMembership,
    settings,
    isCommissioner,
    membershipsLoading,
    selectionResolved,
  ]);

  return <LeagueContext.Provider value={value}>{children}</LeagueContext.Provider>;
}

export function useLeagueContext() {
  const context = useContext(LeagueContext);
  if (context === undefined) {
    throw new Error('useLeagueContext must be used within a LeagueProvider');
  }
  return context;
}
