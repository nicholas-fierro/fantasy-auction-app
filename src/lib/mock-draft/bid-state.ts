export function getMockBidState(
  pending: { price: number; uncontested: boolean },
  userMaxBid: number,
) {
  const minBid = pending.uncontested ? pending.price : pending.price + 1;
  return {
    minBid,
    canCounter: !pending.uncontested && minBid <= userMaxBid,
  };
}
