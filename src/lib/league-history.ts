import type PocketBase from 'pocketbase';
import { mapLeagueRecord } from '@/lib/league';
import type { RosterSettings } from '@/lib/roster';
import { DEFAULT_VALUE_MODEL_CONFIG, type ValueModelConfig } from '@/lib/value-model';

export interface LeagueHistoryScope {
  leagueId: string;
  settings: RosterSettings;
  teamCount: number;
}

// External auctions have no stored settings or teams. The existing importer and
// checked-in board use this single shape; the importer must reject other shapes
// until board metadata is persisted. Never guess a format from paid-slot counts.
export const EXTERNAL_BOARD_SHAPE = { budget: 200, paidAuctionSlots: 7, teamCount: 12 } as const;

export function requireLeagueId(leagueId: string): void {
  if (typeof leagueId !== 'string' || !leagueId.trim()) throw new Error('A league id is required');
}

export async function loadLeagueHistoryScope(
  pb: PocketBase,
  leagueId: string
): Promise<LeagueHistoryScope> {
  requireLeagueId(leagueId);
  const [record, teams] = await Promise.all([
    pb.collection('leagues').getOne(leagueId, { requestKey: null }),
    pb.collection('fantasy_teams').getFullList({
      filter: pb.filter('league = {:leagueId}', { leagueId }),
      requestKey: null,
    }),
  ]);
  return {
    leagueId,
    settings: mapLeagueRecord(record).settings,
    teamCount: teams.filter((team) => team.league === leagueId).length,
  };
}

export function acceptsExternalBoards(scope: LeagueHistoryScope): boolean {
  const { settings, teamCount } = scope;
  return (settings.draftFormat === 'auction' || settings.draftFormat === 'hybrid') &&
    settings.budget === EXTERNAL_BOARD_SHAPE.budget &&
    settings.paidAuctionSlots === EXTERNAL_BOARD_SHAPE.paidAuctionSlots &&
    teamCount === EXTERNAL_BOARD_SHAPE.teamCount;
}

export interface HistoryAuction {
  id: string;
  year: number;
  type: string;
  status: string;
  league: string;
  external?: boolean;
  created?: string;
}

// Which same-year auction represents the league: completed beats active, then
// newer `created` wins, then higher id breaks a `created` tie.
export function preferAuction<T extends HistoryAuction>(candidate: T, incumbent: T): boolean {
  if ((candidate.status === 'completed') !== (incumbent.status === 'completed')) {
    return candidate.status === 'completed';
  }
  if ((candidate.created ?? '') !== (incumbent.created ?? '')) {
    return (candidate.created ?? '') > (incumbent.created ?? '');
  }
  return candidate.id > incumbent.id;
}

// Scope BEFORE collapsing duplicate years. A dual member's newer draft in a
// different league must never displace this league's prices or synthesize $0s.
export function selectHistoryAuctions<T extends HistoryAuction>(
  auctions: T[],
  scope: LeagueHistoryScope,
  includeExternal = true
): T[] {
  requireLeagueId(scope.leagueId);
  const chosen = new Map<number, T>();
  const external: T[] = [];
  for (const auction of auctions) {
    if (auction.type !== 'official' || !(auction.year > 0)) continue;
    if (auction.external) {
      if (includeExternal && !auction.league && auction.status === 'completed' && acceptsExternalBoards(scope)) external.push(auction);
      continue;
    }
    if (auction.league !== scope.leagueId) continue;
    const previous = chosen.get(auction.year);
    if (!previous || preferAuction(auction, previous)) {
      chosen.set(auction.year, auction);
    }
  }
  return [...chosen.values(), ...external];
}

export function historyAuctionFilter(pb: PocketBase, scope: LeagueHistoryScope, includeExternal = true): string {
  return pb.filter(
    `type = "official" && year > 0 && (league = {:leagueId}${includeExternal && acceptsExternalBoards(scope) ? ' || (external = true && league = "" && status = "completed")' : ''})`,
    { leagueId: scope.leagueId }
  );
}

export function leagueValueModelConfig(scope: LeagueHistoryScope): ValueModelConfig {
  const { settings, teamCount } = scope;
  if (settings.draftFormat !== 'auction' && settings.draftFormat !== 'hybrid') {
    throw new Error('Snake leagues do not have projected auction prices');
  }
  if (!Number.isInteger(teamCount) || teamCount <= 0 ||
    !Number.isInteger(settings.paidAuctionSlots) || settings.paidAuctionSlots <= 0 ||
    !Number.isFinite(settings.budget) || settings.budget <= 0) {
    throw new Error('Projected prices require a valid league budget, paid slots, and team count');
  }
  return {
    ...DEFAULT_VALUE_MODEL_CONFIG,
    budget: settings.budget * teamCount,
    draftedPoolSize: settings.paidAuctionSlots * teamCount,
  };
}
