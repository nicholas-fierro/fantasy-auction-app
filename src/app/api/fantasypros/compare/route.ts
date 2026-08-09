import { NextRequest, NextResponse } from 'next/server';
import type PocketBase from 'pocketbase';
import { requireAuth } from '@/server/lib/pocketbase';
import { rateLimit } from '@/server/lib/rate-limit';
import type { ComparablePlayer } from '@/lib/draft-comparison';
import {
  FantasyProsUnavailableError,
  getFantasyProsDraftComparison,
  isFantasyProsConfigured,
} from '@/server/lib/fantasypros';

export const runtime = 'nodejs';

const POSITIONS = new Set(['QB', 'RB', 'WR', 'TE', 'K', 'DST']);

function value(searchParams: URLSearchParams, key: string): string {
  return (searchParams.get(key) ?? '').trim();
}

// Resolve a local `players` record id to the FantasyPros-comparable fields
// from the database, so clients can't use this route as a generic FantasyPros
// proxy with arbitrary ids/names. Returns null for unknown ids or players
// without a valid position or FantasyPros mapping.
async function resolvePlayer(pb: PocketBase, id: string): Promise<ComparablePlayer | null> {
  let record;
  try {
    // requestKey: null disables the SDK's auto-cancellation, which would
    // otherwise abort one of the two concurrent getOne calls.
    record = await pb.collection('players').getOne(id, { requestKey: null });
  } catch {
    return null;
  }

  const player: ComparablePlayer = {
    id: record.id,
    name: (record.name ?? '').trim(),
    position: (record.position ?? '').trim().toUpperCase(),
    fantasypros_id: (record.fantasypros_id ?? '').trim() || null,
  };
  const mapped = Boolean(
    player.name && POSITIONS.has(player.position) && /^\d+$/.test(player.fantasypros_id ?? ''),
  );
  return mapped ? player : null;
}

export async function GET(request: NextRequest) {
  try {
    const { pb, userId } = await requireAuth();

    // Protect the upstream FantasyPros quota: 60 requests / hour per user.
    const limit = rateLimit(`fantasypros:${userId}`, 60, 60 * 60 * 1000);
    if (!limit.allowed) {
      return NextResponse.json(
        { error: 'Too many comparison requests. Try again later.' },
        { status: 429, headers: { 'Retry-After': String(limit.retryAfterSeconds) } },
      );
    }

    if (!isFantasyProsConfigured()) {
      return NextResponse.json({ comparison: null, unavailable: 'FantasyPros API key is not configured.' });
    }

    const firstId = value(request.nextUrl.searchParams, 'p1');
    const secondId = value(request.nextUrl.searchParams, 'p2');
    if (!firstId || !secondId || firstId === secondId) {
      return NextResponse.json({ error: 'Provide two distinct, mapped NFL players.' }, { status: 400 });
    }

    const [first, second] = await Promise.all([
      resolvePlayer(pb, firstId),
      resolvePlayer(pb, secondId),
    ]);
    if (!first || !second || first.fantasypros_id === second.fantasypros_id) {
      return NextResponse.json({ error: 'Provide two distinct, mapped NFL players.' }, { status: 400 });
    }

    const comparison = await getFantasyProsDraftComparison([first, second]);
    return NextResponse.json({ comparison });
  } catch (error) {
    if (error instanceof FantasyProsUnavailableError) {
      return NextResponse.json({ comparison: null, unavailable: error.message });
    }
    if (error instanceof Error && error.message === 'Not authenticated') {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }
    console.error('FantasyPros comparison failed:', error);
    return NextResponse.json({ error: 'Unable to load FantasyPros comparison.' }, { status: 502 });
  }
}
