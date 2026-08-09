'use server';

import { cookies } from 'next/headers';
import { AUTH_COOKIE } from '@/server/lib/pocketbase';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
}

const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 7; // matches PB's default auth token duration

// Mirror the browser-side PocketBase session into the httpOnly `pb_auth` cookie
// that the Next.js middleware and the server-side import pipeline read.
//
// Authentication now happens client-side (pb.collection('users').authWithPassword
// in the login page); this action only persists the resulting token in the exact
// shape src/server/lib/pocketbase.ts parses — { token, record: {id,email,name} } —
// so setting the cookie server-side guarantees identical encoding to what those
// consumers expect (and keeps it httpOnly).
export async function syncSession(token: string, user: AuthUser): Promise<void> {
  (await cookies()).set(AUTH_COOKIE, JSON.stringify({ token, record: user }), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: COOKIE_MAX_AGE_SECONDS,
  });
}

export async function logout(): Promise<void> {
  (await cookies()).delete(AUTH_COOKIE);
}
