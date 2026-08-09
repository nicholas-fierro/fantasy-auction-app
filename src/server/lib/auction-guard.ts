import PocketBase from 'pocketbase';
import { Auction } from '@/server/types/auction';

// Reports "not found" rather than "not yours" so auction ids can't be probed
export async function assertAuctionOwned(
  pb: PocketBase,
  userId: string,
  auctionId: string
): Promise<Auction> {
  const record = await pb.collection('auctions').getOne<Auction>(auctionId);

  if (record.user !== userId) {
    throw new Error('Auction not found');
  }

  return record;
}
