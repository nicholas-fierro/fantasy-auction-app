import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { middleware } from './middleware';

function requestWithCookie(pathname: string, cookieJson?: string) {
  const headers = new Headers();
  if (cookieJson !== undefined) {
    headers.set('cookie', `pb_auth=${encodeURIComponent(cookieJson)}`);
  }
  return new NextRequest(new Request(`http://localhost${pathname}`, { headers }));
}

// PocketBase's auth-refresh endpoint is what actually verifies a token's
// signature and expiry; the middleware must defer to it instead of trusting
// the cookie's own (attacker-controlled) JSON.
describe('middleware', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('redirects to /login when no cookie is present', async () => {
    const res = await middleware(requestWithCookie('/'));
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('/login');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a forged/tampered cookie that PocketBase refuses', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 401 }));
    const cookie = JSON.stringify({ token: 'forged.tampered.sig', record: { id: 'attacker-chosen-id' } });

    const res = await middleware(requestWithCookie('/', cookie));

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/collections/users/auth-refresh'),
      expect.objectContaining({ method: 'POST', headers: { Authorization: 'forged.tampered.sig' } })
    );
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('/login');
  });

  it('rejects an expired token', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 401 }));
    const cookie = JSON.stringify({ token: 'expired.token.here', record: { id: 'user1' } });

    const res = await middleware(requestWithCookie('/', cookie));

    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('/login');
  });

  it('passes through a cookie PocketBase confirms is valid', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ token: 'new.token', record: { id: 'user1' } }), { status: 200 })
    );
    const cookie = JSON.stringify({ token: 'valid.token.here', record: { id: 'user1' } });

    const res = await middleware(requestWithCookie('/', cookie));

    expect(res.status).toBe(200);
    expect(res.headers.get('x-middleware-next')).toBe('1');
  });

  it('rejects when PocketBase is unreachable', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    const cookie = JSON.stringify({ token: 'valid.token.here', record: { id: 'user1' } });

    const res = await middleware(requestWithCookie('/', cookie));

    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('/login');
  });

  it('lets an unauthenticated request through to /login', async () => {
    const res = await middleware(requestWithCookie('/login'));
    expect(res.status).toBe(200);
  });
});
