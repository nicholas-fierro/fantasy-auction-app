import { describe, expect, it } from 'vitest';
import {
  calculateBudgetSummary,
  DEFAULT_ROSTER_SETTINGS,
  isDraftFormat,
  validateRosterSettings,
  type DraftFormat,
  type RosterSettings,
} from './roster';

const snakeSettings: RosterSettings = {
  ...DEFAULT_ROSTER_SETTINGS,
  draftFormat: 'snake',
  budget: 0,
  paidAuctionSlots: 0,
  minimumBid: 0,
  scoringFormat: 'ppr',
  benchSize: 5,
};

describe('draft format defaults', () => {
  it('keeps the existing hybrid league settings', () => {
    expect(DEFAULT_ROSTER_SETTINGS).toMatchObject({
      draftFormat: 'hybrid',
      budget: 200,
      paidAuctionSlots: 7,
      minimumBid: 1,
      scoringFormat: 'half',
      benchSize: 6,
    });
    expect(validateRosterSettings(DEFAULT_ROSTER_SETTINGS)).toBeNull();
  });

  it.each(['auction', 'hybrid', 'snake'])('recognizes %s', (format) => {
    expect(isDraftFormat(format)).toBe(true);
  });

  it.each(['unknown', '', 0, null, undefined])('rejects invalid format %s', (format) => {
    expect(isDraftFormat(format)).toBe(false);
  });
});

describe('validateRosterSettings', () => {
  it('accepts a pure snake roster with zero budget, slots, and minimum bid', () => {
    expect(validateRosterSettings(snakeSettings)).toBeNull();
    expect(snakeSettings.starterPositions.length + snakeSettings.benchSize).toBe(14);
    expect(calculateBudgetSummary([], snakeSettings)).toEqual({
      totalSpent: 0,
      remainingBudget: 0,
      remainingAuctionPicks: 0,
      maxBid: 0,
    });
  });

  it('allows non-negative unused budget and minimum bid for snake', () => {
    expect(validateRosterSettings({ ...snakeSettings, budget: 200, minimumBid: 1 })).toBeNull();
  });

  it.each([1, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects snake paid slots %s',
    (paidAuctionSlots) => {
      expect(validateRosterSettings({ ...snakeSettings, paidAuctionSlots }))
        .toBe('Snake drafts must have zero paid slots');
    },
  );

  it.each(['budget', 'minimumBid'] as const)('rejects invalid snake %s', (field) => {
    for (const value of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(validateRosterSettings({ ...snakeSettings, [field]: value })).not.toBeNull();
    }
  });

  describe.each(['auction', 'hybrid'] as const)('%s settings', (draftFormat) => {
    const settings: RosterSettings = { ...DEFAULT_ROSTER_SETTINGS, draftFormat };

    it('accepts a coherent paid-slot budget', () => {
      expect(validateRosterSettings(settings)).toBeNull();
      expect(validateRosterSettings({ ...settings, budget: 7, minimumBid: 1 })).toBeNull();
    });

    it.each([0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY])(
      'rejects paid slots %s rather than inferring snake',
      (paidAuctionSlots) => {
        expect(validateRosterSettings({ ...settings, paidAuctionSlots }))
          .toBe('Paid slots must be a positive integer');
      },
    );

    it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('rejects budget %s', (budget) => {
      expect(validateRosterSettings({ ...settings, budget })).toBe('Budget must be a positive number up to 1000000');
    });

    it.each([0, 0.5, -1, Number.NaN, Number.POSITIVE_INFINITY])('rejects minimum bid %s', (minimumBid) => {
      expect(validateRosterSettings({ ...settings, minimumBid })).toBe('Minimum bid must be at least $1 and at most 1000000');
    });

    it('requires enough budget to fill every paid slot at the minimum bid', () => {
      expect(validateRosterSettings({ ...settings, budget: 13, minimumBid: 2 }))
        .toBe('Budget must cover all paid slots at the minimum bid');
      expect(validateRosterSettings({ ...settings, budget: 14, minimumBid: 2 })).toBeNull();
    });

    it('requires paid slots to fit the roster', () => {
      expect(validateRosterSettings({ ...settings, starterPositions: ['QB'], benchSize: 5 }))
        .toBe('Paid slots cannot exceed starter positions plus bench size');
      expect(validateRosterSettings({ ...settings, starterPositions: ['QB'], benchSize: 6 })).toBeNull();
    });
  });

  it.each(['auction', 'hybrid', 'snake'] as const)('validates roster shape for %s', (draftFormat) => {
    const settings = draftFormat === 'snake' ? snakeSettings : { ...DEFAULT_ROSTER_SETTINGS, draftFormat };
    expect(validateRosterSettings({ ...settings, starterPositions: [] })).toBe('Use 1–50 starter positions: QB, RB, WR, TE, FLEX, K, DST.');
    for (const benchSize of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(validateRosterSettings({ ...settings, benchSize })).toBe('Bench size must be an integer from 0 to 50');
    }
    expect(validateRosterSettings({ ...settings, benchSize: 0 })).toBeNull();
  });

  it('rejects an unknown draft format', () => {
    expect(validateRosterSettings({ ...DEFAULT_ROSTER_SETTINGS, draftFormat: 'unknown' as DraftFormat }))
      .toBe('Choose a valid draft format');
  });

  it.each(['auction', 'hybrid', 'snake'] as const)('matches the create-league route bounds for %s', (draftFormat) => {
    const settings = draftFormat === 'snake' ? snakeSettings : { ...DEFAULT_ROSTER_SETTINGS, draftFormat };
    expect(validateRosterSettings({ ...settings, budget: 1000001 })).not.toBeNull();
    expect(validateRosterSettings({ ...settings, minimumBid: 1000001 })).not.toBeNull();
    expect(validateRosterSettings({ ...settings, benchSize: 51 })).not.toBeNull();
    expect(validateRosterSettings({ ...settings, starterPositions: ['XX'] })).toBe(
      'Use 1–50 starter positions: QB, RB, WR, TE, FLEX, K, DST.');
    expect(validateRosterSettings({
      ...settings, starterPositions: Array.from({ length: 51 }, () => 'QB'),
    })).not.toBeNull();
  });
});
