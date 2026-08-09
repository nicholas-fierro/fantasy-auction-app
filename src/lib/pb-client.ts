import PocketBase from 'pocketbase';

// Browser-side PocketBase singleton. All direct browser -> PocketBase reads,
// writes, and realtime subscriptions route through this one instance so the SDK
// multiplexes a single SSE connection and shares one auth store.
//
// PocketBase's default authStore (LocalAuthStore) persists the token + record to
// localStorage, so the session survives reloads. The Next.js middleware and the
// remaining server actions (CSV import) read auth from the `pb_auth` cookie
// instead; `syncSession` in src/server/actions/auth.ts keeps that cookie mirrored
// to this store on login / refresh.

const POCKETBASE_URL =
  process.env.NEXT_PUBLIC_POCKETBASE_URL || 'http://127.0.0.1:8090';

export const pb = new PocketBase(POCKETBASE_URL);
