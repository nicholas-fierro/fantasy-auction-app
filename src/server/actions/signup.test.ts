import { describe, it, expect } from 'vitest';
import { validateInvite } from '@/server/lib/invite';

const HOUR = 60 * 60 * 1000;

describe('validateInvite', () => {
  const now = new Date('2026-07-19T12:00:00Z');
  const future = new Date(now.getTime() + HOUR).toISOString();
  const past = new Date(now.getTime() - HOUR).toISOString();

  it('accepts an unused, unexpired invite', () => {
    expect(validateInvite({ expires: future }, { now })).toEqual({ ok: true });
  });

  it('matches a pinned email case-insensitively', () => {
    const r = validateInvite(
      { expires: future, email: 'Owner@Example.com' },
      { now, email: 'owner@example.com' }
    );
    expect(r.ok).toBe(true);
  });

  it('rejects an already-consumed invite', () => {
    const r = validateInvite({ used_by: 'u1', expires: future }, { now });
    expect(r).toEqual({ ok: false, reason: 'already consumed' });
  });

  it('rejects an expired invite', () => {
    const r = validateInvite({ expires: past }, { now });
    expect(r).toEqual({ ok: false, reason: 'expired' });
  });

  it('rejects an email mismatch', () => {
    const r = validateInvite(
      { expires: future, email: 'a@example.com' },
      { now, email: 'b@example.com' }
    );
    expect(r).toEqual({ ok: false, reason: 'email mismatch' });
  });

  // Fail closed: no/empty/unparseable expiry is invalid, never "never expires".
  it.each([undefined, '', '   ', 'not-a-date'])(
    'rejects a missing/unparseable expiry (%j)',
    (expires) => {
      const r = validateInvite({ expires: expires as string | undefined }, { now });
      expect(r.ok).toBe(false);
    }
  );
});

// Single-use race. The real atomic gate is the partial UNIQUE index on
// league_members.invite (migration 1784220000): both signups pass the read-time
// validateInvite, then both attempt the membership INSERT and the DB admits
// exactly one. This models that index — a duplicate invite key is rejected — and
// asserts exactly one of two concurrent redemptions wins. The full live-PB
// integration concurrency test lands in issue #37.
describe('concurrent invite redemption (single-use gate)', () => {
  it('admits exactly one of two racing redemptions', async () => {
    const consumedInvites = new Set<string>(); // models the unique index

    // Models pb.collection('league_members').create({ invite }): the unique
    // index rejects a second row for the same invite. Synchronous check-and-add
    // is atomic on JS's single thread, matching SQLite's atomic unique insert.
    async function createMembership(invite: string): Promise<void> {
      await Promise.resolve();
      if (consumedInvites.has(invite)) {
        throw new Error('unique constraint failed: league_members.invite');
      }
      consumedInvites.add(invite);
    }

    async function redeem(invite: string): Promise<boolean> {
      // Both callers first pass the read-time gate (unused + unexpired).
      const check = validateInvite({ expires: new Date(Date.now() + HOUR).toISOString() });
      expect(check.ok).toBe(true);
      try {
        // requestKey:null would go here on the real SDK call (AGENTS.md gotcha);
        // fresh service clients mean auto-cancel doesn't actually apply.
        await createMembership(invite);
        return true;
      } catch {
        return false; // loser: rolled back to a clean generic failure
      }
    }

    const results = await Promise.all([redeem('inv-1'), redeem('inv-1')]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });
});
