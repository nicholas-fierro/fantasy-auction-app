import { describe, it, expect, vi, beforeEach } from 'vitest';

// requireAuth() reads the pb_auth cookie via next/headers `cookies()`, which
// throws outside a real request scope — stub it with an in-memory store.
const cookieStore = new Map<string, { value: string }>();
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => cookieStore.get(name),
  }),
}));

// Fake PocketBase client: authStore mirrors the real SDK's shape closely
// enough for requireAuth's checks, and `authRefresh` is the stand-in for
// PocketBase actually verifying the token's signature/expiry server-side —
// each test controls whether that call succeeds or throws, the same way a
// forged/expired/valid token would behave against a live PocketBase.
let authRefreshImpl: () => Promise<{ token: string; record: { id: string } }>;

class FakeAuthStore {
  token = '';
  record: { id: string } | null = null;
  get isValid() {
    return !!this.token && !!this.record;
  }
  save(token: string, record: { id: string } | null) {
    this.token = token;
    this.record = record;
  }
  clear() {
    this.token = '';
    this.record = null;
  }
}

class FakePocketBase {
  authStore = new FakeAuthStore();
  collection() {
    const authStore = this.authStore;
    return {
      async authRefresh() {
        const result = await authRefreshImpl();
        authStore.save(result.token, result.record);
        return result;
      },
    };
  }
}

vi.mock('pocketbase', () => ({ default: FakePocketBase }));

const { requireAuth } = await import('./pocketbase');

function seedCookie(token: string, recordId: string) {
  cookieStore.set('pb_auth', {
    value: JSON.stringify({ token, record: { id: recordId } }),
  });
}

describe('requireAuth', () => {
  beforeEach(() => {
    cookieStore.clear();
  });

  it('rejects a forged/tampered cookie — PocketBase refuses the signature', async () => {
    seedCookie('forged.tampered.sig', 'attacker-chosen-id');
    authRefreshImpl = async () => {
      throw new Error('invalid token signature');
    };

    await expect(requireAuth()).rejects.toThrow('Not authenticated');
  });

  it('rejects an expired token', async () => {
    seedCookie('expired.token.here', 'user1');
    authRefreshImpl = async () => {
      throw new Error('token has expired');
    };

    await expect(requireAuth()).rejects.toThrow('Not authenticated');
  });

  it('rejects when there is no cookie at all', async () => {
    await expect(requireAuth()).rejects.toThrow('Not authenticated');
  });

  it('accepts a valid cookie and returns PocketBase-verified identity', async () => {
    seedCookie('valid.token.here', 'user1');
    authRefreshImpl = async () => ({ token: 'refreshed.token', record: { id: 'user1' } });

    const { userId } = await requireAuth();

    expect(userId).toBe('user1');
  });
});
