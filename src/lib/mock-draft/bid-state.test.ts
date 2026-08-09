import { describe, expect, it } from 'vitest';
import { getMockBidState } from './bid-state';

describe('getMockBidState', () => {
  it('uses current price uncontested and next dollar when countering', () => {
    expect(getMockBidState({ price: 80, uncontested: true }, 80)).toEqual({
      minBid: 80,
      canCounter: false,
    });
    expect(getMockBidState({ price: 80, uncontested: false }, 81)).toEqual({
      minBid: 81,
      canCounter: true,
    });
    expect(getMockBidState({ price: 80, uncontested: false }, 80)).toEqual({
      minBid: 81,
      canCounter: false,
    });
  });
});
