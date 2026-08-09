'use client';

import { useEffect } from 'react';
import { pb } from '@/lib/pb-client';
import { syncSession, logout } from '@/server/actions/auth';

// Keeps the browser PocketBase session healthy for the authenticated app shell.
// On mount it refreshes the token (extending the session and re-mirroring it into
// the pb_auth cookie the middleware/import pipeline read). A failed refresh means
// the stored token is invalid/expired -> clear both stores and bounce to /login.
export function SessionProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    let cancelled = false;

    async function refresh() {
      if (!pb.authStore.isValid) {
        // Middleware should already have redirected; guard defensively.
        await logout();
        window.location.href = '/login';
        return;
      }

      try {
        const authData = await pb.collection('users').authRefresh();
        if (cancelled) return;
        await syncSession(authData.token, {
          id: authData.record.id,
          email: authData.record.email,
          name: authData.record.name || '',
        });
      } catch {
        if (cancelled) return;
        pb.authStore.clear();
        await logout();
        window.location.href = '/login';
      }
    }

    refresh();
    return () => {
      cancelled = true;
    };
  }, []);

  return <>{children}</>;
}
