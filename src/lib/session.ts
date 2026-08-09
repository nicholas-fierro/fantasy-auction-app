'use client';

import { pb } from '@/lib/pb-client';
import { logout } from '@/server/actions/auth';

// Sign out from both stores: the browser-side SDK token/localStorage and the
// httpOnly cookie mirror the middleware reads. Full navigation (not router.push)
// drops the query cache with the session. Shared by the sidebar and the
// Settings > Profile "Sign out" action.
export async function signOut() {
  pb.authStore.clear();
  await logout();
  window.location.href = '/login';
}
