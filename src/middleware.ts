import { NextRequest, NextResponse } from 'next/server';

const POCKETBASE_URL = process.env.POCKETBASE_URL || 'http://127.0.0.1:8090';

// Real enforcement still happens in PocketBase's API rules (AD-3) — this only
// gates login-redirect behavior. But it must actually ask PocketBase whether
// the token is genuine: decoding the JWT payload locally (the old approach)
// trusts the cookie's own claims, so a forged/tampered token with a fake
// future `exp` would pass. auth-refresh makes PB verify the signature and
// expiry itself.
export async function hasValidAuthCookie(request: NextRequest): Promise<boolean> {
  const raw = request.cookies.get('pb_auth')?.value;
  if (!raw) return false;

  try {
    const { token } = JSON.parse(raw);
    if (!token) return false;

    const res = await fetch(`${POCKETBASE_URL}/api/collections/users/auth-refresh`, {
      method: 'POST',
      headers: { Authorization: token },
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function middleware(request: NextRequest) {
  const isAuthenticated = await hasValidAuthCookie(request);
  const { pathname } = request.nextUrl;
  // Public pages: login and invite-based signup.
  const isPublicPage = pathname === '/login' || pathname === '/signup';

  if (!isAuthenticated && !isPublicPage) {
    return NextResponse.redirect(new URL('/login', request.url));
  }
  if (isAuthenticated && isPublicPage) {
    return NextResponse.redirect(new URL('/', request.url));
  }

  return NextResponse.next();
}

// Static assets are excluded: the browser fetches the manifest and icons without
// credentials, so running them through the auth redirect above would 307 them to
// /login and the app would never be installable. None of them carry private data.
export const config = {
  matcher: ['/((?!_next/static|_next/image|.*\\.(?:svg|png|ico|webmanifest)$).*)'],
};
