// Pure invite-validation logic, split out of the signupWithInvite server action
// so it can be exported (a 'use server' module may only export async functions)
// and unit-tested without pulling in next/headers.

// One opaque message for every invite-validation failure (invalid token,
// expired, already consumed, wrong email). Collapsing them denies an
// enumeration oracle to unauthenticated callers; the specific reason is only
// ever written to the server log.
export const GENERIC_INVITE_ERROR = 'This invite link is not valid or has expired.';

// The subset of an invite record validateInvite reads. Kept structural so the
// function is unit-testable without a PocketBase record instance.
export interface InviteFields {
  used_by?: string;
  expires?: string;
  email?: string;
}

// Shared by signup and the pre-auth preview. Returns the server-log-only reason
// on failure; callers surface GENERIC_INVITE_ERROR. Fails closed: an invite with
// no/empty/unparseable expiry is invalid, never treated as never-expiring.
export function validateInvite(
  invite: InviteFields,
  opts: { email?: string; now?: Date } = {}
): { ok: true } | { ok: false; reason: string } {
  const now = opts.now ?? new Date();
  if (invite.used_by) return { ok: false, reason: 'already consumed' };
  if (!invite.expires || String(invite.expires).trim() === '') {
    return { ok: false, reason: 'missing expiry (fail closed)' };
  }
  const expires = new Date(invite.expires);
  if (Number.isNaN(expires.getTime())) {
    return { ok: false, reason: 'unparseable expiry (fail closed)' };
  }
  if (expires < now) return { ok: false, reason: 'expired' };
  // opts.email is expected already trimmed + lowercased by the caller.
  if (opts.email && invite.email && invite.email.toLowerCase() !== opts.email) {
    return { ok: false, reason: 'email mismatch' };
  }
  return { ok: true };
}
