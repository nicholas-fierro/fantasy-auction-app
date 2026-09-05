import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Auction } from '@/server/types/auction';

const mocks = vi.hoisted(() => ({
  enterDraftRoom: vi.fn(),
  queryClient: {
    setQueryData: vi.fn(),
    invalidateQueries: vi.fn(),
    removeQueries: vi.fn(),
  },
  useMutation: vi.fn(),
}));

vi.mock('@tanstack/react-query', () => ({
  useMutation: mocks.useMutation,
  useQueryClient: () => mocks.queryClient,
}));
vi.mock('@/contexts/navigation-context', () => ({
  useNavigation: () => ({ enterDraftRoom: mocks.enterDraftRoom }),
}));
vi.mock('@/contexts/auction-context', () => ({
  useAuction: () => ({ selectedAuctionId: null, setSelectedAuctionId: vi.fn() }),
}));
vi.mock('@/server/actions/auctions', () => ({
  createAuction: vi.fn(),
  completeAuction: vi.fn(),
  deleteAuction: vi.fn(),
  replaceAuction: vi.fn(),
}));

const { useCreateAuction, useReplaceAuction } = await import('./use-auctions');

const auction: Auction = {
  id: 'auction-new',
  name: 'New draft',
  year: 2026,
  type: 'mock',
  sim: false,
  status: 'active',
  user: 'user-1',
  league: 'league-2',
  external: false,
  drafted_at: '2026-09-04T00:00:00.000Z',
  created: '2026-09-04T00:00:00.000Z',
  updated: '2026-09-04T00:00:00.000Z',
};

type MutationOptions = {
  onSuccess: (newAuction: Auction, variables?: {
    activeId: string;
    resolution: 'complete' | 'delete';
  }) => void;
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.useMutation.mockImplementation(options => options);
});

describe('auction creation navigation', () => {
  it('passes the returned league when entering a newly created draft', () => {
    useCreateAuction();
    const options = mocks.useMutation.mock.calls[0][0] as MutationOptions;

    options.onSuccess(auction);

    expect(mocks.enterDraftRoom).toHaveBeenCalledWith(auction.id, auction.league);
  });

  it('passes the returned league when entering a replacement draft', () => {
    useReplaceAuction();
    const options = mocks.useMutation.mock.calls[0][0] as MutationOptions;

    options.onSuccess(auction, { activeId: 'auction-old', resolution: 'delete' });

    expect(mocks.enterDraftRoom).toHaveBeenCalledWith(auction.id, auction.league);
  });
});
