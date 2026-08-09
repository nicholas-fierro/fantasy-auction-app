import { cookies } from 'next/headers';
import PocketBase from 'pocketbase';

const POCKETBASE_URL = process.env.POCKETBASE_URL || 'http://127.0.0.1:8090';

export const AUTH_COOKIE = 'pb_auth';

// One client per request: a module-level singleton would share auth state
// across concurrent users' requests on the server.
export async function getPb(): Promise<PocketBase> {
  const pb = new PocketBase(POCKETBASE_URL);

  const raw = (await cookies()).get(AUTH_COOKIE)?.value;
  if (raw) {
    try {
      const { token, record } = JSON.parse(raw);
      pb.authStore.save(token, record);
    } catch {
      // malformed cookie — treat as logged out
    }
  }

  return pb;
}

export async function requireAuth(): Promise<{ pb: PocketBase; userId: string }> {
  const pb = await getPb();

  if (!pb.authStore.isValid || !pb.authStore.record?.id) {
    throw new Error('Not authenticated');
  }

  // The cookie's token and record are client-supplied input — a forged or
  // tampered cookie can claim an arbitrary record.id, and `authStore.isValid`
  // above only checks the JWT's shape/exp locally, not its signature. Ask
  // PocketBase to verify the token itself; on success this also refreshes
  // authStore with PB's authoritative record, so callers that branch on
  // `userId` (commissioner checks, ownership checks) trust PB's answer.
  try {
    await pb.collection('users').authRefresh();
  } catch {
    throw new Error('Not authenticated');
  }

  if (!pb.authStore.isValid || !pb.authStore.record?.id) {
    throw new Error('Not authenticated');
  }

  return { pb, userId: pb.authStore.record.id };
}
