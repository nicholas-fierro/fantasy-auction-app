import { NextResponse } from 'next/server';
import { unstable_cache } from 'next/cache';
import { requireAuth } from '@/server/lib/pocketbase';
import {
  normalizeSleeperInjuries,
  type PlayerInjuriesResponse,
  type SleeperPlayerRecord,
} from '@/lib/sleeper-injuries';

const SLEEPER_PLAYERS_URL = 'https://api.sleeper.app/v1/players/nfl';
const ONE_DAY_SECONDS = 24 * 60 * 60;

// Sleeper's raw player dump is larger than Next's per-entry data-cache limit.
// Fetch it without storage, reduce it to the compact injury-only map, and cache
// that result instead. The cached function is shared across app users.
const loadPlayerInjuries = unstable_cache(
  async (): Promise<PlayerInjuriesResponse> => {
    const response = await fetch(SLEEPER_PLAYERS_URL, {
      cache: 'no-store',
    });

    if (!response.ok) {
      throw new Error(`Sleeper players request failed (${response.status})`);
    }

    const players = await response.json() as Record<string, SleeperPlayerRecord>;
    return {
      injuries: normalizeSleeperInjuries(players),
      fetchedAt: new Date().toISOString(),
    };
  },
  ['sleeper-player-injuries-v1'],
  { revalidate: ONE_DAY_SECONDS }
);

export async function GET() {
  // Authenticated surface: the browser sends the
  // httpOnly pb_auth cookie automatically on this same-origin fetch.
  try {
    await requireAuth();
  } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  try {
    // Sleeper asks consumers to fetch this large dataset at most once per day.
    const payload = await loadPlayerInjuries();

    return NextResponse.json(payload, {
      headers: { 'Cache-Control': 'private, max-age=3600' },
    });
  } catch (error) {
    console.error('Failed to load Sleeper injury data:', error);
    return NextResponse.json(
      { error: 'Injury data unavailable right now.' },
      { status: 502 }
    );
  }
}
