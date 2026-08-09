'use server';

import PocketBase from 'pocketbase';
import { headers } from 'next/headers';
import { GENERIC_INVITE_ERROR } from '@/server/lib/invite';
import { rateLimit, clientIp } from '@/server/lib/rate-limit';

// Invite-based account creation (docs/multi-user-plan.md).
//
// The `users` create API rule is null (AD-2 closed public signup), and PB rules
// can't validate an invite token against another collection during user
// creation. This now runs through a scoped PocketBase route
// (/api/league-admin/signup, pb_hooks/league_admin_routes.pb.js) instead of a
// standing superuser credential (issue #54): the route validates the invite,
// creates the (verified) user, binds the league_members row, and marks the
// invite used — all inside one PB transaction. This action only rate-limits and
// maps the route's machine-readable error `code` to the existing user-facing
// strings. The client then logs in through the normal authWithPassword +
// syncSession path.

export interface SignupInput {
  token: string;
  email: string;
  password: string;
  name: string;
}

export interface SignupResult {
  ok: boolean;
  error?: string;
}

// League/team context for the signup page, safe to expose pre-auth: enough to
// confirm the invite is real and show who the user is joining as. Never returns
// the token, the pinning email, or anything else sensitive.
export interface InviteInfoResult {
  ok: boolean;
  leagueName?: string;
  teamName?: string;
  emailLocked?: boolean;
  error?: string;
}

// Per-IP rate limits: signup 10 / 15min, invite preview 30 / 15min. Shared
// in-memory limiter (see its per-instance ceiling note in
// src/server/lib/rate-limit.ts); the goal is to blunt brute-force token guessing.
const WINDOW_MS = 15 * 60 * 1000;

async function getClientIp(): Promise<string> {
  return clientIp(await headers());
}

export async function signupWithInvite(input: SignupInput): Promise<SignupResult> {
  const email = input.email.trim().toLowerCase();
  const name = input.name.trim();
  if (!input.token || !email || !input.password) {
    return { ok: false, error: 'Missing required fields' };
  }
  if (input.password.length < 8) {
    return { ok: false, error: 'Password must be at least 8 characters' };
  }

  const ip = await getClientIp();
  if (!rateLimit(`signup:${ip}`, 10, WINDOW_MS).allowed) {
    return { ok: false, error: 'Too many attempts — wait a few minutes and try again' };
  }

  // Scoped PB route does the privileged work (validate invite → create verified
  // user → bind membership → mark invite used) in one transaction. Plain
  // unauthenticated client — no superuser credential in this runtime.
  const pb = new PocketBase(process.env.POCKETBASE_URL || 'http://127.0.0.1:8090');
  try {
    await pb.send('/api/league-admin/signup', {
      method: 'POST',
      body: { token: input.token, email, password: input.password, name },
    });
    return { ok: true };
  } catch (error) {
    const code =
      (error as { response?: { code?: string } })?.response?.code ??
      (error as { data?: { code?: string } })?.data?.code;
    switch (code) {
      case 'email_exists':
        return { ok: false, error: 'An account with this email already exists' };
      case 'invite_claimed':
        return { ok: false, error: 'Could not join the league — this invite may already be claimed.' };
      case 'invite_invalid':
        return { ok: false, error: GENERIC_INVITE_ERROR };
      case 'invalid_input':
        return { ok: false, error: 'Missing required fields' };
      default:
        console.error('Signup failed:', error);
        return { ok: false, error: 'Could not create the account' };
    }
  }
}

// Read-only invite preview for the signup page. Runs through the scoped PB route
// because the invites collection has no public read rule (commissioner-only).
// Deliberately narrow: league name, pinned team name, and whether the invite is
// locked to a specific email — nothing that would leak the token or membership.
export async function getInviteInfo(token: string): Promise<InviteInfoResult> {
  if (!token) {
    return { ok: false, error: 'Invite required' };
  }

  const ip = await getClientIp();
  if (!rateLimit(`invite-preview:${ip}`, 30, WINDOW_MS).allowed) {
    // Generic throttle: doesn't reveal whether the invite is valid (#33 posture).
    return { ok: false, error: 'Too many requests — wait a few minutes and try again' };
  }

  const pb = new PocketBase(process.env.POCKETBASE_URL || 'http://127.0.0.1:8090');
  try {
    const res = await pb.send('/api/league-admin/invite-preview', {
      method: 'POST',
      body: { token },
    });
    return {
      ok: true,
      leagueName: res.leagueName || undefined,
      teamName: res.teamName || undefined,
      emailLocked: !!res.emailLocked,
    };
  } catch (error) {
    const code =
      (error as { response?: { code?: string } })?.response?.code ??
      (error as { data?: { code?: string } })?.data?.code;
    if (code === 'invite_invalid') {
      return { ok: false, error: GENERIC_INVITE_ERROR };
    }
    console.error('Invite preview failed:', error);
    return { ok: false, error: 'Signup is not available right now' };
  }
}
