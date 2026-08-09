'use server';

import { requireAuth } from '@/server/lib/pocketbase';

// Commissioner-only member administration that PB API rules can't express on
// their own. Password reset covers the no-SMTP draft-morning lockout: without a
// mail server PocketBase's self-serve reset never lands, so the commissioner
// mints a temporary password out of band.
//
// The privileged reads/writes now run through scoped PB routes
// (/api/league-admin/members and /reset-password, pb_hooks/league_admin_routes.pb.js)
// instead of a standing superuser credential (issue #54). The routes enforce the
// commissioner check server-side from the caller's own token — which requireAuth
// forwards via pb.send — so this action just relays and maps errors.

export interface ResetPasswordResult {
  ok: boolean;
  password?: string;
  error?: string;
}

export interface LeagueMemberInfo {
  id: string;
  league: string;
  user: string;
  userName: string;
  userEmail: string;
  fantasy_team: string;
  teamName: string;
}

// Members' display names/emails live on the `users` collection, whose rules
// only let a user read their own record (`id = @request.auth.id`). Expanding
// `user` on league_members from the browser therefore returns nothing for
// anyone but the caller — hence this commissioner-gated server action using
// the service client to read the names/emails other members can't see.
export async function getLeagueMembers(leagueId: string): Promise<LeagueMemberInfo[]> {
  if (!leagueId) {
    return [];
  }

  let pb;
  try {
    ({ pb } = await requireAuth());
  } catch {
    return [];
  }

  // The route enforces the commissioner check; a non-commissioner gets 403,
  // which lands here and returns [] — same behavior as before.
  try {
    const res = await pb.send('/api/league-admin/members', {
      method: 'GET',
      query: { league: leagueId },
    });
    return (res.members || []).map((m: LeagueMemberInfo) => ({
      id: m.id,
      league: m.league,
      user: m.user,
      userName: m.userName || '',
      userEmail: m.userEmail || '',
      fantasy_team: m.fantasy_team || '',
      teamName: m.teamName || '',
    }));
  } catch {
    return [];
  }
}

export async function resetMemberPassword(memberId: string): Promise<ResetPasswordResult> {
  if (!memberId) {
    return { ok: false, error: 'No member specified' };
  }

  let pb;
  try {
    ({ pb } = await requireAuth());
  } catch {
    return { ok: false, error: 'Not authenticated' };
  }

  // The route enforces the commissioner check and mints the temp password.
  try {
    const res = await pb.send('/api/league-admin/reset-password', {
      method: 'POST',
      body: { memberId },
    });
    return { ok: true, password: res.password };
  } catch (error) {
    const status = (error as { status?: number })?.status;
    const code =
      (error as { response?: { code?: string } })?.response?.code ??
      (error as { data?: { code?: string } })?.data?.code;
    if (status === 403 || code === 'forbidden') {
      return { ok: false, error: 'Only the league commissioner can reset passwords' };
    }
    if (status === 404) {
      return { ok: false, error: 'Member not found' };
    }
    if (code === 'no_account') {
      return { ok: false, error: 'This member has no account yet' };
    }
    console.error('Password reset failed:', error);
    return { ok: false, error: 'Could not reset the password' };
  }
}
