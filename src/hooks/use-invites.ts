'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { pb } from '@/lib/pb-client';
import { getLeagueMembers } from '@/server/actions/members';

// Commissioner-side invite + membership management (docs/multi-user-plan.md).
// All queries are commissioner-scoped by the invites / league_members API
// rules; these hooks just read and write.

export interface Invite {
  id: string;
  league: string;
  token: string;
  email: string;
  fantasy_team: string;
  used_by: string;
  expires: string;
  created: string;
}

export interface LeagueMember {
  id: string;
  league: string;
  user: string;
  userName: string;
  userEmail: string;
  fantasy_team: string;
  teamName: string;
}

export function useInvites(leagueId: string | null) {
  return useQuery({
    queryKey: ['invites', leagueId],
    queryFn: async (): Promise<Invite[]> => {
      const records = await pb.collection('invites').getFullList({
        filter: pb.filter('league = {:leagueId}', { leagueId }),
        sort: '-created',
      });
      return records.map(record => ({
        id: record.id,
        league: record.league,
        token: record.token,
        email: record.email || '',
        fantasy_team: record.fantasy_team || '',
        used_by: record.used_by || '',
        expires: record.expires || '',
        created: record.created,
      }));
    },
    enabled: !!leagueId,
  });
}

export function useLeagueMembers(leagueId: string | null) {
  return useQuery({
    queryKey: ['league-members', leagueId],
    queryFn: async (): Promise<LeagueMember[]> => {
      if (!leagueId) return [];
      // Names/emails come from a commissioner-gated server action: the
      // `users` collection's rules only let a user read their own record, so
      // expanding `user` on league_members from the browser can't see other
      // members' names/emails (only the service client can).
      return getLeagueMembers(leagueId);
    },
    enabled: !!leagueId,
  });
}

// Fresh URL-safe token; uniqueness enforced by the invites index.
function newInviteToken(): string {
  return crypto.randomUUID().replace(/-/g, '');
}

// Default invite lifetime: one week from creation. The League UI can override
// with an explicit date; signupWithInvite / getInviteInfo enforce it server-side.
export const DEFAULT_INVITE_TTL_DAYS = 7;

export function defaultInviteExpiry(): string {
  return new Date(Date.now() + DEFAULT_INVITE_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

export function useCreateInvite(leagueId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (values: { email?: string; fantasy_team?: string; expires?: string }) => {
      if (!leagueId) throw new Error('No league selected');
      return pb.collection('invites').create({
        league: leagueId,
        token: newInviteToken(),
        email: values.email || null,
        fantasy_team: values.fantasy_team || null,
        expires: values.expires || defaultInviteExpiry(),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['invites', leagueId] });
    },
  });
}

// Rotate an unused invite's token (and refresh its expiry), invalidating any
// previously shared link. The invites update rule is commissioner-scoped, so
// this needs no server action.
export function useRegenerateInvite(leagueId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      return pb.collection('invites').update(id, {
        token: newInviteToken(),
        expires: defaultInviteExpiry(),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['invites', leagueId] });
    },
  });
}

export function useDeleteInvite(leagueId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await pb.collection('invites').delete(id);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['invites', leagueId] });
    },
  });
}
