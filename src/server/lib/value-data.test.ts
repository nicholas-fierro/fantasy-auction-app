import { describe, expect, it, vi } from 'vitest';
import type PocketBase from 'pocketbase';
import { loadFromPocketBase } from '@/server/lib/value-data';

function fakePocketBase() {
  const collections = {
    auctions: { getFullList: vi.fn(async () => []) },
    player_seasons: {
      getFullList: vi.fn(async () => [
        {
          id: 'season-1',
          player_id: 'player-1',
          year: 2026,
          rank: 12,
          position_rank: 5,
          rank_ppr: 3,
          position_rank_ppr: 2,
          projected_auction_value: 24,
        },
      ]),
    },
    players: { getFullList: vi.fn(async () => []) },
  };
  return {
    filter: vi.fn((filter: string) => filter),
    collection: vi.fn((name: keyof typeof collections) => collections[name]),
  } as unknown as PocketBase;
}

describe('loadFromPocketBase', () => {
  it('normalizes season rankings from the requested scoring-format board', async () => {
    await expect(loadFromPocketBase(fakePocketBase(), 'half')).resolves.toMatchObject({
      seasons: [{ rank: 12, position_rank: 5 }],
    });
    await expect(loadFromPocketBase(fakePocketBase(), 'std')).resolves.toMatchObject({
      seasons: [{ rank: 12, position_rank: 5 }],
    });
    await expect(loadFromPocketBase(fakePocketBase(), 'ppr')).resolves.toMatchObject({
      seasons: [{ rank: 3, position_rank: 2 }],
    });
  });
});
