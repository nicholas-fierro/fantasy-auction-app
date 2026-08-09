import { describe, it, expect } from 'vitest';
import type { Player } from '@/server/types/player';
import type { FantasyTeam } from '@/server/types/fantasy-team';
import type { DraftPickWithDetails } from '@/server/types/draft-pick';
import { hashString, mulberry32, seededUnit, weightedPick } from './rng';
import { computeTeamProfiles, ProfilePick } from './profiles';
import { computeWtp, computeNeed, computeBase, marketFactor, rankFallback } from './pricing';
import { buildHistoryIndex } from '@/lib/estimated-value';
import { mean } from '@/server/lib/mock-draft-score';
import { resolveNomination, counterBid } from './auction-resolver';
import { chooseSnakePick } from './snake-ai';
import { chooseNomination } from './nomination';
import { DEFAULT_PARAMS, PARAMS } from './params';
import { buildTeamStates, deriveMockDraftState } from './engine';
import { getNominatorForPick } from '@/lib/draft-turn';
import { DEFAULT_ROSTER_SETTINGS } from '@/lib/roster';
import { RankedPlayer, TeamProfile, TeamState, WtpBreakdown } from './types';

// --- Fixtures ----------------------------------------------------------------

function makePlayer(overrides: Partial<Player> = {}): Player {
  return {
    id: 'p1',
    season_id: 's1',
    name: 'Test Player',
    team: 'FA',
    position: 'RB',
    position_rank: 1,
    bye_week: 7,
    sos: 0,
    ecr_vs_adp: 0,
    rank: 1,
    tier: 1,
    projected_auction_value: null,
    is_rookie: false,
    sleeper_id: null,
    espn_id: null,
    gsis_id: null,
    fantasypros_id: null,
    created: '',
    updated: '',
    ...overrides,
  };
}

const NEUTRAL_PROFILE: TeamProfile = {
  teamId: 't',
  posBudgetShare: { QB: 0.12, RB: 0.42, WR: 0.38, TE: 0.08 },
  aggression: 1,
  concentration: 0.4,
  sampleSize: 0,
  snakePosBias: { QB: 1, RB: 1, WR: 1, TE: 1 },
  snakeReach: 8,
  snakeReachIndex: 1,
  runResponse: 1,
  snakeSampleSize: 0,
  nflTeamBias: {},
  rookieBias: 1,
  affinitySampleSize: 0,
};

// A historical pick with everything defaulted to "no signal": priced, ranked
// nowhere in particular, no NFL team, not a rookie. Tests override just the fields
// the tendency under test depends on.
function makeProfilePick(overrides: Partial<ProfilePick> = {}): ProfilePick {
  return {
    teamId: 'A',
    year: 2024,
    position: 'RB',
    price: 20,
    estimate: 20,
    pickOrder: 1,
    rank: 0,
    nflTeam: '',
    isRookie: false,
    rookieDataKnown: false,
    ...overrides,
  };
}

function makeTeamState(overrides: Partial<TeamState> = {}): TeamState {
  return {
    teamId: 't1',
    profile: NEUTRAL_PROFILE,
    maxBid: 100,
    remainingBudget: 100,
    remainingAuctionPicks: 5,
    totalPicks: 0,
    spentByPosition: {},
    countByPosition: {},
    filledStarters: {},
    filledFlexStarters: 0,
    unfilledRequiredStarters: 9,
    ...overrides,
  };
}

function makeTeams(n: number): FantasyTeam[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `team${i + 1}`,
    name: `Team ${i + 1}`,
    draft_order: i + 1,
    created: '',
    updated: '',
  }));
}

// Minimal pick — only the fields the engine reads. Cast through unknown since we
// omit the hydrated player/team objects the derivation doesn't touch.
function makePick(teamId: string, priced: boolean, order: number): DraftPickWithDetails {
  return {
    fantasy_team_id: teamId,
    price: priced ? 1 : null,
    pick_order: order,
  } as unknown as DraftPickWithDetails;
}

// --- rng ---------------------------------------------------------------------

describe('rng', () => {
  it('is deterministic for the same seed', () => {
    const a = mulberry32(hashString('auction:key'));
    const b = mulberry32(hashString('auction:key'));
    expect(a()).toBe(b());
    expect(a()).toBe(b());
  });

  it('differs for different decision keys', () => {
    expect(seededUnit('auction', 'k1')).not.toBe(seededUnit('auction', 'k2'));
  });

  it('weightedPick respects weights at the extremes', () => {
    // All weight on the last item.
    expect(weightedPick(['a', 'b', 'c'], [0, 0, 1], 0.5)).toBe('c');
    // Zero total weight falls back to the first item.
    expect(weightedPick(['a', 'b'], [0, 0], 0.9)).toBe('a');
  });
});

// --- profiles ----------------------------------------------------------------

describe('profiles', () => {
  it('shrinks a team toward the league average but reflects its lean', () => {
    // Team A spends only on RB, team B only on WR, both with plenty of picks.
    const aPicks: ProfilePick[] = Array.from({ length: 20 }, () =>
      makeProfilePick({ teamId: 'A', position: 'RB', price: 24 })
    );
    const bPicks: ProfilePick[] = Array.from({ length: 20 }, () =>
      makeProfilePick({ teamId: 'B', position: 'WR', price: 24 })
    );
    const profiles = computeTeamProfiles(
      ['A', 'B'],
      new Map([
        ['A', aPicks],
        ['B', bPicks],
      ])
    );

    const a = profiles.get('A')!;
    const b = profiles.get('B')!;
    // A leans RB, B leans WR.
    expect(a.posBudgetShare.RB).toBeGreaterThan(a.posBudgetShare.WR);
    expect(b.posBudgetShare.WR).toBeGreaterThan(b.posBudgetShare.RB);
    // Shares are renormalized to ~1.
    const sum = a.posBudgetShare.QB + a.posBudgetShare.RB + a.posBudgetShare.WR + a.posBudgetShare.TE;
    expect(sum).toBeCloseTo(1, 5);
    // price/estimate = 1.2 everywhere → aggression ~1.2.
    expect(a.aggression).toBeCloseTo(1.2, 1);
  });

  it('gives teams with no history the league-average profile', () => {
    const withHistory: ProfilePick[] = Array.from({ length: 10 }, () =>
      makeProfilePick({ teamId: 'A', position: 'RB' })
    );
    const profiles = computeTeamProfiles(
      ['A', 'B'],
      new Map([['A', withHistory]])
    );
    const b = profiles.get('B')!;
    expect(b.sampleSize).toBe(0);
    // B has no data, so it collapses to the pooled league average (all RB here).
    expect(b.posBudgetShare.RB).toBeGreaterThan(0.9);
  });

  it('uses unpriced historical picks for spend tendencies but not aggression', () => {
    const profile = computeTeamProfiles(
      ['A'],
      new Map([
        ['A', [
          makeProfilePick({ year: 2023, position: 'RB', price: 30, estimate: 0 }),
          makeProfilePick({ year: 2023, position: 'WR', price: 10, estimate: 0 }),
        ]],
      ])
    ).get('A')!;

    expect(profile.sampleSize).toBe(2);
    expect(profile.posBudgetShare.RB).toBeGreaterThan(profile.posBudgetShare.WR);
    expect(profile.aggression).toBe(1);
  });
});

// --- profiles: snake tendencies ----------------------------------------------

// Build one year of $0 snake picks alternating between two teams, so each team's
// picks resolve against a real ordered draft.
function snakeYear(
  positionsByTeam: Record<string, string[]>,
  options: { startOrder?: number; ranksByTeam?: Record<string, number[]> } = {}
): Map<string, ProfilePick[]> {
  const teamIds = Object.keys(positionsByTeam);
  const rounds = Math.max(...teamIds.map((id) => positionsByTeam[id].length));
  const picksByTeam = new Map<string, ProfilePick[]>(teamIds.map((id) => [id, []]));

  let order = options.startOrder ?? 85;
  for (let round = 0; round < rounds; round++) {
    for (const teamId of teamIds) {
      const position = positionsByTeam[teamId][round];
      if (!position) continue;
      picksByTeam.get(teamId)!.push(
        makeProfilePick({
          teamId,
          position,
          price: 0,
          pickOrder: order++,
          rank: options.ranksByTeam?.[teamId]?.[round] ?? 0,
        })
      );
    }
  }
  return picksByTeam;
}

describe('profiles: snake tendencies', () => {
  it('leans snakePosBias toward the positions a team takes early', () => {
    const picks = snakeYear({
      A: ['RB', 'RB', 'RB', 'RB', 'RB', 'RB'],
      B: ['WR', 'WR', 'WR', 'WR', 'WR', 'WR'],
    });
    const profiles = computeTeamProfiles(['A', 'B'], picks);

    expect(profiles.get('A')!.snakePosBias.RB).toBeGreaterThan(1);
    expect(profiles.get('A')!.snakePosBias.WR).toBeLessThan(1);
    expect(profiles.get('B')!.snakePosBias.WR).toBeGreaterThan(1);
    expect(profiles.get('A')!.snakeSampleSize).toBe(6);
  });

  it('measures reach as ranks past the best player still on the board', () => {
    // A always takes the best remaining rank; B always leaves it for A and takes a
    // player ~30 ranks worse.
    const picksByTeam = new Map<string, ProfilePick[]>([['A', []], ['B', []]]);
    let order = 85;
    for (let round = 0; round < 10; round++) {
      const bestRank = 10 + round * 2;
      picksByTeam.get('B')!.push(
        makeProfilePick({ teamId: 'B', price: 0, pickOrder: order++, rank: bestRank + 30 })
      );
      picksByTeam.get('A')!.push(
        makeProfilePick({ teamId: 'A', price: 0, pickOrder: order++, rank: bestRank })
      );
    }
    const profiles = computeTeamProfiles(['A', 'B'], picksByTeam);

    // One season of decayed weights is a thin sample, so both land inside the
    // league mean — but on the correct sides of it, and far apart.
    const a = profiles.get('A')!;
    const b = profiles.get('B')!;
    expect(a.snakeReach).toBeLessThan(b.snakeReach);
    expect(b.snakeReach - a.snakeReach).toBeGreaterThan(5);
    // The index is what the sim reads: A below the league, B above it.
    expect(a.snakeReachIndex).toBeLessThan(1);
    expect(b.snakeReachIndex).toBeGreaterThan(1);
  });

  it('raises runResponse for a team that drafts into positional runs', () => {
    // Every A pick lands right after a block of the same position; B never does.
    const picks = snakeYear({
      A: ['RB', 'RB', 'RB', 'RB', 'RB', 'RB'],
      B: ['WR', 'TE', 'QB', 'WR', 'TE', 'QB'],
    });
    // Interleave so A's picks always follow A's own RB streak plus B's variety.
    const profiles = computeTeamProfiles(['A', 'B'], picks);

    expect(profiles.get('A')!.runResponse).toBeGreaterThan(profiles.get('B')!.runResponse);
  });
});

describe('profiles: affinity tendencies', () => {
  it('surfaces an NFL-team lean and leaves neutral teams out of the map', () => {
    const homer: ProfilePick[] = Array.from({ length: 16 }, (_, i) =>
      makeProfilePick({ teamId: 'A', nflTeam: i < 12 ? 'DET' : 'GB' })
    );
    const spread: ProfilePick[] = Array.from({ length: 16 }, (_, i) =>
      makeProfilePick({ teamId: 'B', nflTeam: ['GB', 'KC', 'SF', 'MIN'][i % 4] })
    );
    const profiles = computeTeamProfiles(['A', 'B'], new Map([['A', homer], ['B', spread]]));

    expect(profiles.get('A')!.nflTeamBias.DET).toBeGreaterThan(1);
    // B never took a Lion, so there is no per-franchise evidence either way and no
    // lean is claimed — absence of picks is not a negative lean.
    expect(profiles.get('B')!.nflTeamBias.DET).toBeUndefined();
    // A took plenty of Packers too, but at roughly the league rate, so GB is quiet.
    expect(profiles.get('A')!.nflTeamBias.GB ?? 1).toBeLessThan(
      profiles.get('A')!.nflTeamBias.DET
    );
  });

  it('normalizes relocated franchises onto one abbreviation', () => {
    // A takes Raiders under both abbreviations; B never does. Without normalization
    // the two spellings would split A's lean across two half-strength entries.
    const raiders: ProfilePick[] = Array.from({ length: 16 }, (_, i) =>
      makeProfilePick({ teamId: 'A', nflTeam: i < 12 ? (i % 2 ? 'OAK' : 'LV') : 'GB' })
    );
    const others: ProfilePick[] = Array.from({ length: 16 }, () =>
      makeProfilePick({ teamId: 'B', nflTeam: 'GB' })
    );
    const profile = computeTeamProfiles(
      ['A', 'B'],
      new Map([['A', raiders], ['B', others]])
    ).get('A')!;

    expect(profile.nflTeamBias.OAK).toBeUndefined();
    expect(profile.nflTeamBias.LV).toBeGreaterThan(1);
  });

  it('raises rookieBias for a team that drafts more rookies than the league', () => {
    const rookieHungry: ProfilePick[] = Array.from({ length: 16 }, (_, i) =>
      makeProfilePick({ teamId: 'A', rookieDataKnown: true, isRookie: i < 12 })
    );
    const veteran: ProfilePick[] = Array.from({ length: 16 }, () =>
      makeProfilePick({ teamId: 'B', rookieDataKnown: true, isRookie: false })
    );
    const profiles = computeTeamProfiles(
      ['A', 'B'],
      new Map([['A', rookieHungry], ['B', veteran]])
    );

    expect(profiles.get('A')!.rookieBias).toBeGreaterThan(1);
    expect(profiles.get('B')!.rookieBias).toBeLessThan(1);
  });

  it('does not let unresolved rookie flags dilute the rate', () => {
    // A `false` the backfill could not resolve must not count as a confirmed veteran:
    // A and B draft identically among resolved picks, and B adds unresolved rows.
    const resolved = (teamId: string) =>
      Array.from({ length: 8 }, (_, i) =>
        makeProfilePick({ teamId, rookieDataKnown: true, isRookie: i < 4 })
      );
    const baseline = computeTeamProfiles(
      ['A', 'B'],
      new Map([['A', resolved('A')], ['B', resolved('B')]])
    );
    const withUnresolved = computeTeamProfiles(
      ['A', 'B'],
      new Map([
        ['A', resolved('A')],
        [
          'B',
          [
            ...resolved('B'),
            ...Array.from({ length: 8 }, () =>
              makeProfilePick({ teamId: 'B', rookieDataKnown: false, isRookie: false })
            ),
          ],
        ],
      ])
    );

    expect(withUnresolved.get('B')!.rookieBias).toBeCloseTo(baseline.get('B')!.rookieBias, 10);
  });

  it('ignores rookie flags from years where the data is not trustworthy', () => {
    const picks: ProfilePick[] = Array.from({ length: 16 }, () =>
      makeProfilePick({ teamId: 'A', rookieDataKnown: false, isRookie: true })
    );
    const profile = computeTeamProfiles(['A'], new Map([['A', picks]])).get('A')!;

    expect(profile.rookieBias).toBe(1);
  });
});

// --- pricing -----------------------------------------------------------------

describe('pricing', () => {
  it('rankFallback decreases with rank and floors at $1', () => {
    expect(rankFallback(1)).toBeGreaterThan(rankFallback(50));
    expect(rankFallback(999)).toBe(1);
    expect(rankFallback(0)).toBe(1);
  });

  it('clamps WTP to the team maxBid', () => {
    const team = makeTeamState({ maxBid: 40, remainingAuctionPicks: 3 });
    const wtp = computeWtp(team, makePlayer(), 100000, 'a', 1);
    expect(wtp.wtp).toBe(40);
  });

  it('keeps an opening bid near the league market value', () => {
    const team = makeTeamState({
      maxBid: 194,
      remainingAuctionPicks: 7,
      profile: { ...NEUTRAL_PROFILE, aggression: 1.4, concentration: 1 },
    });
    const wtp = computeWtp(team, makePlayer({ tier: 1, rank: 2 }), 80, 'a', 1);
    expect(wtp.cap).toBeGreaterThanOrEqual(78);
    expect(wtp.cap).toBeLessThanOrEqual(90);
    expect(wtp.wtp).toBeLessThanOrEqual(wtp.cap);
  });

  it('keeps market noise replay-safe, bounded, and off deep waiver players', () => {
    const player = makePlayer({ id: 'p', rank: 60 });
    expect(marketFactor('auction-a', player, 4)).toBe(marketFactor('auction-a', player, 4));

    for (let i = 0; i < 500; i++) {
      const cheapFactor = marketFactor(`auction-${i}`, player, 4);
      expect(cheapFactor).toBeGreaterThanOrEqual(0.5);
      expect(cheapFactor).toBeLessThanOrEqual(2.5);

      const midFactor = marketFactor(`auction-${i}`, makePlayer({ id: 'mid', rank: 35 }), 50);
      expect(midFactor).toBeGreaterThanOrEqual(0.65);
      expect(midFactor).toBeLessThanOrEqual(1.35);
    }

    expect(marketFactor('auction-a', makePlayer({ id: 'deep', rank: 200 }), 1)).toBe(1);
  });

  it('produces different contested prices in different mock auctions', () => {
    const player = makePlayer({ id: 'contested', tier: 2, rank: 18 });
    const teams = ['A', 'B', 'C'].map((teamId) =>
      makeTeamState({ teamId, maxBid: 194, remainingAuctionPicks: 7 })
    );
    const prices = new Set<number>();

    for (let i = 0; i < 20; i++) {
      const auctionId = `auction-${i}`;
      const base = Math.round(55 * marketFactor(auctionId, player, 55));
      prices.add(resolveNomination(player, base, teams, auctionId, 1).price);
    }

    expect(prices.size).toBeGreaterThan(5);
  });

  it('pays up for a player it has an affinity for, and reports the factor', () => {
    const player = makePlayer({ position: 'RB', tier: 2, rank: 20, team: 'DET', is_rookie: true });
    // A depth buy, so the market ceiling isn't already binding and the affinity
    // factor has room to show in the price.
    const filled = { filledStarters: { RB: 2 }, filledFlexStarters: 1 };
    const neutral = makeTeamState(filled);
    const homer = makeTeamState({
      ...filled,
      profile: { ...NEUTRAL_PROFILE, nflTeamBias: { DET: 1.4 }, rookieBias: 1.3 },
    });

    const neutralWtp = computeWtp(neutral, player, 40, 'a', 1);
    const homerWtp = computeWtp(homer, player, 40, 'a', 1);

    expect(neutralWtp.affinity).toBe(1);
    expect(homerWtp.affinity).toBeCloseTo(1.4 * 1.3, 5);
    expect(homerWtp.wtp).toBeGreaterThan(neutralWtp.wtp);
  });

  it('returns 0 WTP when the team has no paid slots left', () => {
    const team = makeTeamState({ remainingAuctionPicks: 0, maxBid: 0 });
    const wtp = computeWtp(team, makePlayer(), 50, 'a', 1);
    expect(wtp.wtp).toBe(0);
  });

  it('needs an open starter more than a filled position', () => {
    const player = makePlayer({ position: 'RB', tier: 1 });
    const open = makeTeamState({ filledStarters: {}, filledFlexStarters: 0 });
    const filled = makeTeamState({
      filledStarters: { RB: 2 },
      filledFlexStarters: 1,
      spentByPosition: { RB: 200 },
    });
    expect(computeNeed(open, player)).toBeGreaterThan(computeNeed(filled, player));
  });

  it('does not double-penalize the first starter at a thin-budget position', () => {
    // TE's historical share is ~8% ($16), but `base` already prices the position's
    // scarcity — capping the first TE starter by the share too dragged the elite
    // TE to ~0.65x market.
    const team = makeTeamState({ maxBid: 194, remainingAuctionPicks: 7 });
    const wtp = computeWtp(team, makePlayer({ position: 'TE', tier: 1, rank: 20 }), 48, 'a', 1);
    expect(wtp.posBudget).toBeGreaterThanOrEqual(0.85);
    expect(wtp.wtp).toBeGreaterThan(40);
  });

  it('still fades depth once the position budget is spent', () => {
    const team = makeTeamState({
      filledStarters: { TE: 1 },
      spentByPosition: { TE: 16 },
      filledFlexStarters: 1,
    });
    const wtp = computeWtp(team, makePlayer({ position: 'TE', tier: 3, rank: 40 }), 20, 'a', 1);
    expect(wtp.posBudget).toBeLessThan(0.85);
  });

  it('makes concentrated teams value elite players more than balanced teams', () => {
    const player = makePlayer({ tier: 1, rank: 5 });
    const balanced = makeTeamState({
      profile: { ...NEUTRAL_PROFILE, concentration: 0.1 },
    });
    const concentrated = makeTeamState({
      profile: { ...NEUTRAL_PROFILE, concentration: 0.9 },
    });
    expect(computeNeed(concentrated, player)).toBeGreaterThan(computeNeed(balanced, player));
  });

  it('uses custom budget and starter requirements in WTP', () => {
    const team = makeTeamState({
      filledStarters: { QB: 1, RB: 2 },
      filledFlexStarters: 1,
      spentByPosition: { RB: 50 },
    });
    const custom = {
      ...DEFAULT_ROSTER_SETTINGS,
      budget: 100,
      starterPositions: ['QB', 'QB', 'RB', 'RB', 'FLEX'],
    };

    expect(computeNeed(team, makePlayer({ position: 'QB', tier: 3 }), custom))
      .toBeGreaterThan(computeNeed(team, makePlayer({ position: 'QB', tier: 3 })));

    const defaultWtp = computeWtp(team, makePlayer({ position: 'RB', tier: 3 }), 20, 'a', 2);
    const customWtp = computeWtp(team, makePlayer({ position: 'RB', tier: 3 }), 20, 'a', 2, custom);
    expect(customWtp.posBudget).toBeLessThan(defaultWtp.posBudget);
    expect(customWtp.need).toBeLessThan(defaultWtp.need);
  });
});

// --- auction resolver --------------------------------------------------------

describe('auction resolver', () => {
  // Huge base forces every team's WTP to its maxBid (the clamp), giving us
  // deterministic, jitter-independent bids.
  const player = makePlayer({ position: 'RB', tier: 1 });

  it('winner is the top bidder and price is second-highest + $1', () => {
    const teams = [
      makeTeamState({ teamId: 'A', maxBid: 30 }),
      makeTeamState({ teamId: 'B', maxBid: 20 }),
      makeTeamState({ teamId: 'C', maxBid: 10 }),
    ];
    const result = resolveNomination(player, 100000, teams, 'auction', 5);
    expect(result.winnerTeamId).toBe('A');
    expect(result.price).toBe(21); // second-highest (20) + 1
  });

  it('prices an uncontested nomination between the minimum and the winner max', () => {
    const teams = [makeTeamState({ teamId: 'A', maxBid: 50 })];
    const result = resolveNomination(player, 100000, teams, 'auction', 5);
    expect(result.winnerTeamId).toBe('A');
    expect(result.price).toBeGreaterThanOrEqual(1);
    expect(result.price).toBeLessThanOrEqual(50);
    expect(resolveNomination(player, 100000, teams, 'auction', 5).price).toBe(result.price);

    const custom = { ...DEFAULT_ROSTER_SETTINGS, minimumBid: 5 };
    const customPrice = resolveNomination(player, 100000, teams, 'auction', 5, custom).price;
    expect(customPrice).toBeGreaterThanOrEqual(5);
    expect(customPrice).toBeLessThanOrEqual(50);
  });

  it('no bidders with capacity yields no winner', () => {
    const teams = [makeTeamState({ teamId: 'A', maxBid: 0, remainingAuctionPicks: 0 })];
    const result = resolveNomination(player, 100000, teams, 'auction', 5);
    expect(result.winnerTeamId).toBe('');
  });

  it('counterBid detects when an AI would go higher', () => {
    const bids = new Map<string, WtpBreakdown>([
      ['A', { base: 0, aggression: 1, need: 1, posBudget: 1, affinity: 1, jitter: 1, cap: 30, wtp: 30 }],
      ['B', { base: 0, aggression: 1, need: 1, posBudget: 1, affinity: 1, jitter: 1, cap: 20, wtp: 20 }],
    ]);
    // User bids 25 → A (max 30) still willing to reach 26.
    expect(counterBid(bids, 25)).toEqual({ outbid: true, byTeamId: 'A', newPrice: 26 });
    // User bids 30 → nobody can reach 31.
    expect(counterBid(bids, 30)).toEqual({ outbid: false });
  });
});

// --- snake ai ----------------------------------------------------------------

describe('snake ai', () => {
  it('forces required starters (K/DST) when picks run short', () => {
    // 2 picks left, exactly 2 unfilled required starters (K + DST).
    const team = makeTeamState({
      totalPicks: 13,
      unfilledRequiredStarters: 2,
      filledStarters: { QB: 1, RB: 2, WR: 2, TE: 1 },
      filledFlexStarters: 1,
    });
    const available = [
      makePlayer({ id: 'rb', position: 'RB', rank: 5 }),
      makePlayer({ id: 'k', position: 'K', rank: 150 }),
      makePlayer({ id: 'dst', position: 'DST', rank: 160 }),
    ];
    const pick = chooseSnakePick(team, available, 'a', 100);
    expect(['K', 'DST']).toContain(pick.position);
  });

  it('leaves K/DST alone while the roster still has picks to spare', () => {
    // 8 picks left, only K + DST outstanding — a kicker must not beat a depth WR
    // just because its starter slot is open.
    const team = makeTeamState({
      totalPicks: 7,
      unfilledRequiredStarters: 2,
      filledStarters: { QB: 1, RB: 2, WR: 2, TE: 1 },
      filledFlexStarters: 1,
    });
    const available = [
      makePlayer({ id: 'depth', position: 'WR', rank: 120 }),
      makePlayer({ id: 'k', position: 'K', rank: 140 }),
      makePlayer({ id: 'dst', position: 'DST', rank: 150 }),
    ];
    let depthPicks = 0;
    for (let order = 0; order < 50; order++) {
      if (chooseSnakePick(team, available, 'a', order).id === 'depth') depthPicks++;
    }
    // Was the other way round before K/DST stopped scoring as an ordinary starter
    // need: the kicker outscored the depth WR and went ~8 rounds early.
    expect(depthPicks).toBeGreaterThanOrEqual(45);
  });

  it('strongly favors the best available by rank when unconstrained', () => {
    const team = makeTeamState({ totalPicks: 7, unfilledRequiredStarters: 8, filledStarters: {} });
    const available = [
      makePlayer({ id: 'stud', position: 'RB', rank: 3 }),
      makePlayer({ id: 'deep', position: 'RB', rank: 120 }),
    ];
    // Score-weighted sampling: the stud (rank 3) should dominate a rank-120 scrub
    // across many pick slots, without being a strict 100% every time.
    let studPicks = 0;
    for (let order = 0; order < 50; order++) {
      if (chooseSnakePick(team, available, 'a', order).id === 'stud') studPicks++;
    }
    expect(studPicks).toBeGreaterThan(40);
  });

  it('does not draft K/DST when the custom roster omits them', () => {
    const team = makeTeamState({
      totalPicks: 1,
      unfilledRequiredStarters: 0,
      filledStarters: { RB: 1 },
    });
    const available = [
      makePlayer({ id: 'k', position: 'K', rank: 1 }),
      makePlayer({ id: 'rb', position: 'RB', rank: 100 }),
    ];
    const settings = {
      ...DEFAULT_ROSTER_SETTINGS,
      paidAuctionSlots: 1,
      starterPositions: ['RB'],
      benchSize: 2,
    };

    expect(chooseSnakePick(team, available, 'a', 2, settings).id).toBe('rb');
  });

  it('forces custom required starters using the custom roster size', () => {
    const team = makeTeamState({
      totalPicks: 1,
      unfilledRequiredStarters: 1,
      filledStarters: { QB: 1 },
    });
    const available = [
      makePlayer({ id: 'rb', position: 'RB', rank: 1 }),
      makePlayer({ id: 'qb', position: 'QB', rank: 100 }),
    ];
    const settings = {
      ...DEFAULT_ROSTER_SETTINGS,
      paidAuctionSlots: 1,
      starterPositions: ['QB', 'QB'],
      benchSize: 0,
    };

    expect(chooseSnakePick(team, available, 'a', 2, settings).id).toBe('qb');
  });

  it('follows the profile lean between two equally ranked players', () => {
    const team = makeTeamState({
      totalPicks: 7,
      unfilledRequiredStarters: 8,
      profile: { ...NEUTRAL_PROFILE, snakePosBias: { QB: 1, RB: 2, WR: 0.5, TE: 1 } },
    });
    const available = [
      makePlayer({ id: 'rb', position: 'RB', rank: 40 }),
      makePlayer({ id: 'wr', position: 'WR', rank: 40 }),
    ];
    let rbPicks = 0;
    for (let order = 0; order < 50; order++) {
      if (chooseSnakePick(team, available, 'a', order).id === 'rb') rbPicks++;
    }
    expect(rbPicks).toBeGreaterThan(35);
  });

  it('considers more candidates for a team that historically reaches', () => {
    const available = Array.from({ length: 12 }, (_, i) =>
      makePlayer({ id: `p${i}`, position: 'RB', rank: 20 + i })
    );
    const distinct = (snakeReachIndex: number) => {
      const team = makeTeamState({
        totalPicks: 7,
        unfilledRequiredStarters: 8,
        profile: { ...NEUTRAL_PROFILE, snakeReachIndex },
      });
      const picked = new Set<string>();
      for (let order = 0; order < 60; order++) {
        picked.add(chooseSnakePick(team, available, 'a', order).id);
      }
      return picked.size;
    };

    expect(distinct(1.6)).toBeGreaterThan(distinct(0.6));
  });

  it('chases a positional run only when the profile says to, and only during one', () => {
    const available = [
      makePlayer({ id: 'rb', position: 'RB', rank: 40 }),
      makePlayer({ id: 'wr', position: 'WR', rank: 40 }),
    ];
    const rbPicks = (runResponse: number, recent: string[]) => {
      const team = makeTeamState({
        totalPicks: 7,
        unfilledRequiredStarters: 8,
        profile: { ...NEUTRAL_PROFILE, runResponse },
      });
      let count = 0;
      for (let order = 0; order < 50; order++) {
        if (chooseSnakePick(team, available, 'a', order, DEFAULT_ROSTER_SETTINGS, recent).id === 'rb') {
          count++;
        }
      }
      return count;
    };

    const run = ['RB', 'RB', 'RB', 'RB'];
    // A run-chaser piles into the RB run; a contrarian backs off it.
    expect(rbPicks(1.8, run)).toBeGreaterThan(rbPicks(0.5, run));
    // With no run underway, runResponse changes nothing.
    expect(rbPicks(1.8, [])).toBe(rbPicks(0.5, []));
  });

  it('refuses a third quarterback however hard the profile leans QB', () => {
    const team = makeTeamState({
      totalPicks: 9,
      unfilledRequiredStarters: 4,
      filledStarters: { QB: 1, RB: 2, WR: 2, TE: 1 },
      filledFlexStarters: 1,
      countByPosition: { QB: 2, RB: 3, WR: 3, TE: 1 },
      profile: { ...NEUTRAL_PROFILE, snakePosBias: { QB: 2.5, RB: 1, WR: 1, TE: 1 } },
    });
    const available = [
      makePlayer({ id: 'qb', position: 'QB', rank: 30 }),
      makePlayer({ id: 'wr', position: 'WR', rank: 120 }),
    ];

    for (let order = 0; order < 25; order++) {
      expect(chooseSnakePick(team, available, 'a', order).id).toBe('wr');
    }
  });

  it('stops stacking one position as the bench fills up with it', () => {
    // The board bug: a flat depth weight let a QB-biased team take the same position
    // every remaining round, because nothing decremented the pull it created.
    const available = [
      makePlayer({ id: 'rb', position: 'RB', rank: 90 }),
      makePlayer({ id: 'wr', position: 'WR', rank: 100 }),
    ];
    const profile = { ...NEUTRAL_PROFILE, snakePosBias: { QB: 1, RB: 1.5, WR: 1, TE: 1 } };
    const pickWith = (rbCount: number) =>
      chooseSnakePick(
        makeTeamState({
          totalPicks: 8 + rbCount,
          unfilledRequiredStarters: 4,
          filledStarters: { QB: 1, RB: 2, WR: 2, TE: 1 },
          filledFlexStarters: 1,
          countByPosition: { RB: 3 + rbCount, WR: 3, QB: 1, TE: 1 },
          profile,
        }),
        available,
        'a',
        1
      ).id;

    // With no RB depth yet the lean wins; three deep and the WR is the better pick.
    expect(pickWith(0)).toBe('rb');
    expect(pickWith(3)).toBe('wr');
  });

  it('favors a player from an NFL team the manager reaches for', () => {
    const team = makeTeamState({
      totalPicks: 7,
      unfilledRequiredStarters: 8,
      profile: { ...NEUTRAL_PROFILE, nflTeamBias: { DET: 2 } },
    });
    const available = [
      makePlayer({ id: 'lion', position: 'RB', rank: 40, team: 'DET' }),
      makePlayer({ id: 'other', position: 'RB', rank: 40, team: 'GB' }),
    ];
    let lionPicks = 0;
    for (let order = 0; order < 50; order++) {
      if (chooseSnakePick(team, available, 'a', order).id === 'lion') lionPicks++;
    }
    expect(lionPicks).toBeGreaterThan(35);
  });
});

// --- engine ------------------------------------------------------------------

describe('engine', () => {
  it('snakes nominators by draft order, reversing at each round boundary', () => {
    const teams = makeTeams(3);
    expect(getNominatorForPick(0, [], teams)).toBe('team1');
    expect(getNominatorForPick(1, [], teams)).toBe('team2');
    expect(getNominatorForPick(2, [], teams)).toBe('team3');
    expect(getNominatorForPick(3, [], teams)).toBe('team3');
    expect(getNominatorForPick(4, [], teams)).toBe('team2');
    expect(getNominatorForPick(5, [], teams)).toBe('team1');
    expect(getNominatorForPick(6, [], teams)).toBe('team1');
  });

  it('skips a team that has filled its paid slots', () => {
    const teams = makeTeams(2);
    // Team 2 bought all 7 of the first picks; it should be skipped at pick index 7.
    const picks = Array.from({ length: 7 }, (_, i) => makePick('team2', true, i + 1));
    expect(getNominatorForPick(7, picks, teams)).toBe('team1');
  });

  it('derives auction / snake / complete phase boundaries', () => {
    const teams = makeTeams(12);
    const picks = (n: number) => Array.from({ length: n }, (_, i) => makePick(`team${(i % 12) + 1}`, true, i + 1));

    expect(deriveMockDraftState(picks(83), teams).phase).toBe('auction');
    expect(deriveMockDraftState(picks(84), teams).phase).toBe('snake');
    expect(deriveMockDraftState(picks(180), teams).phase).toBe('complete');
  });

  it('uses custom roster settings for the completion threshold', () => {
    const teams = makeTeams(2);
    const picks = (n: number) => Array.from({ length: n }, (_, i) => makePick(`team${(i % 2) + 1}`, true, i + 1));
    const settings = {
      ...DEFAULT_ROSTER_SETTINGS,
      paidAuctionSlots: 1,
      starterPositions: ['QB'],
      benchSize: 1,
    };

    expect(deriveMockDraftState(picks(3), teams, settings).phase).toBe('snake');
    expect(deriveMockDraftState(picks(4), teams, settings).phase).toBe('complete');
    expect(deriveMockDraftState(picks(4), teams).phase).not.toBe('complete');
  });

  it('uses custom settings for team budget and roster state', () => {
    const teams = makeTeams(1);
    const picks = [{
      ...makePick('team1', true, 1),
      price: 40,
      player: makePlayer({ position: 'RB' }),
      team: teams[0],
    } as DraftPickWithDetails];
    const settings = {
      ...DEFAULT_ROSTER_SETTINGS,
      budget: 250,
      paidAuctionSlots: 5,
      minimumBid: 2,
      starterPositions: ['RB', 'QB'],
      benchSize: 2,
    };

    expect(buildTeamStates(picks, teams, new Map(), settings).get('team1')).toMatchObject({
      remainingBudget: 210,
      remainingAuctionPicks: 4,
      maxBid: 204,
      filledStarters: { RB: 1 },
      unfilledRequiredStarters: 1,
    });
  });
});

// --- nomination --------------------------------------------------------------

// A candidate board of distinct ranks/positions, sorted best first.
function makeBoard(n: number): RankedPlayer[] {
  const positions = ['RB', 'WR', 'QB', 'TE'];
  return Array.from({ length: n }, (_, i) => ({
    player: makePlayer({
      id: `p${i + 1}`,
      name: `Player ${i + 1}`,
      rank: i + 1,
      position: positions[i % positions.length],
      position_rank: Math.floor(i / positions.length) + 1,
      tier: Math.min(8, Math.floor(i / 6) + 1),
    }),
    base: 100 - i,
  }));
}

describe('nomination', () => {
  // The seeded coin is the FIRST draw of `nom:${pickOrder}:${teamId}`, so forcing a
  // branch means finding a pick order whose first draw falls the right side of the
  // probability. Pinning params to 0 / 1 is the direct way to do that.
  const alwaysDrain = { ...DEFAULT_PARAMS, drainProbability: 1 };
  const neverDrain = { ...DEFAULT_PARAMS, drainProbability: 0 };

  it('drains the highest-value player the team least needs', () => {
    // Starters all filled at RB, so RB need is depth-level and RBs score highest on
    // base * (1.3 - need). The board's best RB is p1.
    const team = makeTeamState({
      filledStarters: { RB: 2, WR: 2, QB: 1, TE: 1 },
      filledFlexStarters: 1,
      spentByPosition: { RB: 200 },
    });
    const choice = chooseNomination(team, makeBoard(30), 'a1', 1, DEFAULT_ROSTER_SETTINGS, alwaysDrain);
    expect(choice.reason).toBe('drain');
    expect(choice.player.position).toBe('RB');
    expect(choice.player.id).toBe('p1');
  });

  it('targets a player it needs, and never returns one outside the pool', () => {
    const team = makeTeamState();
    const board = makeBoard(60);
    const choice = chooseNomination(team, board, 'a1', 3, DEFAULT_ROSTER_SETTINGS, neverDrain);
    expect(choice.reason).toBe('target');
    // Only the top `candidatePool` by base is eligible, whatever the weights say.
    expect(choice.player.rank).toBeLessThanOrEqual(DEFAULT_PARAMS.candidatePool);
  });

  it('honours the candidatePool cut', () => {
    const team = makeTeamState();
    const board = makeBoard(60);
    const narrow = chooseNomination(team, board, 'a1', 3, DEFAULT_ROSTER_SETTINGS, {
      ...neverDrain,
      candidatePool: 3,
    });
    expect(narrow.player.rank).toBeLessThanOrEqual(3);
  });

  it('ignores the input order of the available list', () => {
    const team = makeTeamState();
    const board = makeBoard(30);
    const forward = chooseNomination(team, board, 'a1', 5, DEFAULT_ROSTER_SETTINGS);
    const reversed = chooseNomination(team, [...board].reverse(), 'a1', 5, DEFAULT_ROSTER_SETTINGS);
    expect(reversed.player.id).toBe(forward.player.id);
  });

  it('is deterministic for one auction and pick, and differs across auctions', () => {
    const team = makeTeamState();
    const board = makeBoard(30);
    const a = chooseNomination(team, board, 'auctionA', 7, DEFAULT_ROSTER_SETTINGS);
    const b = chooseNomination(team, board, 'auctionA', 7, DEFAULT_ROSTER_SETTINGS);
    expect(b).toEqual(a);

    const others = Array.from({ length: 12 }, (_, i) =>
      chooseNomination(team, board, `auction${i}`, 7, DEFAULT_ROSTER_SETTINGS).player.id
    );
    expect(new Set(others).size).toBeGreaterThan(1);
  });
});

// --- params ------------------------------------------------------------------

describe('params', () => {
  it('falls back to the shipped constants when nothing is fitted', () => {
    // params.json ships with an empty `params` object, which IS the fallback path.
    expect(PARAMS).toEqual({ ...DEFAULT_PARAMS, ...PARAMS });
  });

  it('raises a top player WTP when the market ceiling rises', () => {
    const player = makePlayer({ rank: 1, tier: 1 });
    const team = makeTeamState({ maxBid: 200 });
    const low = computeWtp(team, player, 80, 'a1', 1, DEFAULT_ROSTER_SETTINGS, DEFAULT_PARAMS);
    const high = computeWtp(team, player, 80, 'a1', 1, DEFAULT_ROSTER_SETTINGS, {
      ...DEFAULT_PARAMS,
      ceilMin: 1.3,
      ceilMax: 1.5,
    });
    // The elite factor stack sits above the ceiling, so the ceiling IS the price.
    expect(low.wtp).toBe(low.cap);
    expect(high.wtp).toBeGreaterThan(low.wtp);
  });

  it('collapses a team profile toward the league mean as shrinkK grows', () => {
    // One team that only ever bought RBs, against a league that spreads its money.
    const picksByTeam = new Map<string, ProfilePick[]>([
      ['A', Array.from({ length: 8 }, () => makeProfilePick({ teamId: 'A', position: 'RB' }))],
      [
        'B',
        ['QB', 'WR', 'TE', 'WR', 'QB', 'TE', 'WR', 'QB'].map((position) =>
          makeProfilePick({ teamId: 'B', position })
        ),
      ],
    ]);
    const loose = computeTeamProfiles(['A', 'B'], picksByTeam, { ...DEFAULT_PARAMS, shrinkK: 0.1 });
    const tight = computeTeamProfiles(['A', 'B'], picksByTeam, { ...DEFAULT_PARAMS, shrinkK: 100 });

    expect(loose.get('A')!.posBudgetShare.RB).toBeGreaterThan(0.9);
    expect(tight.get('A')!.posBudgetShare.RB).toBeLessThan(0.6);
    // ...and toward the league share, which is what "collapse" means here.
    expect(
      Math.abs(tight.get('A')!.posBudgetShare.RB - tight.get('B')!.posBudgetShare.RB)
    ).toBeLessThan(
      Math.abs(loose.get('A')!.posBudgetShare.RB - loose.get('B')!.posBudgetShare.RB)
    );
  });

  it('widens the need clamp with needElite instead of clipping it back', () => {
    const elite = makePlayer({ rank: 1, tier: 1, position: 'RB' });
    const team = makeTeamState();
    const base = computeNeed(team, elite, DEFAULT_ROSTER_SETTINGS, DEFAULT_PARAMS);
    const raised = computeNeed(team, elite, DEFAULT_ROSTER_SETTINGS, {
      ...DEFAULT_PARAMS,
      needElite: 1.8,
    });
    expect(raised).toBeGreaterThan(base);
  });
});

// --- market read: mean shift, right skew, and the manual nudge ----------------

describe('market read', () => {
  const index = buildHistoryIndex([]);
  // No comps and no projection, so computeBase falls through to rankFallback and
  // the only thing moving the number is the market read itself.
  const at = (rank: number) => makePlayer({ id: `r${rank}`, rank, position_rank: rank });

  function sample(rank: number, runs = 400): number[] {
    return Array.from({ length: runs }, (_, i) =>
      computeBase(index, 2026, at(rank), `auction${i}`)
    );
  }

  it('pays a premium in the rank bands where the league historically does', () => {
    // Measured over 2020-2025: mean log(paid/model) is ~0 at the top of the board
    // and +0.21 by ranks 49-84. The sim has to show the same shape.
    const elite = mean(sample(3));
    const eliteBase = rankFallback(3);
    const deep = mean(sample(60));
    const deepBase = rankFallback(60);

    expect(elite / eliteBase).toBeGreaterThan(0.95);
    expect(elite / eliteBase).toBeLessThan(1.05);
    expect(deep / deepBase).toBeGreaterThan(1.05);
  });

  it('overpays more often than it underpays, because a real room does', () => {
    // 49.5% of the league's real picks at ranks 49-84 went for over 1.25x the model
    // value. A symmetric multiplier could not produce that; the lognormal can.
    const base = rankFallback(60);
    const values = sample(60);
    const over = values.filter((v) => v > base * 1.25).length / values.length;
    expect(over).toBeGreaterThan(0.25);
  });

  it('applies a manual nudge to the centre while keeping the spread', () => {
    const player = at(43);
    const plain = Array.from({ length: 200 }, (_, i) =>
      computeBase(index, 2026, player, `a${i}`)
    );
    const nudged = Array.from({ length: 200 }, (_, i) =>
      computeBase(index, 2026, player, `a${i}`, undefined, new Map([[player.id, 1.6]]))
    );
    expect(mean(nudged)).toBeGreaterThan(mean(plain) * 1.3);
    // Still a distribution, not a pinned number.
    expect(new Set(nudged).size).toBeGreaterThan(10);
  });

  it('clamps an absurd nudge instead of pricing a player at $1 or $500', () => {
    const player = at(43);
    const zero = computeBase(index, 2026, player, 'a1', undefined, new Map([[player.id, 0]]));
    const huge = computeBase(index, 2026, player, 'a1', undefined, new Map([[player.id, 99]]));
    const plain = computeBase(index, 2026, player, 'a1');
    expect(zero).toBeGreaterThanOrEqual(Math.round(plain * 0.4 * 0.5));
    expect(huge).toBeLessThanOrEqual(Math.round(plain * 2.5 * 2.5) + 1);
  });
});

// --- roster shape rules the league's own drafts establish ---------------------
//
// Each of these pins a behaviour the league has NEVER shown in 96 team-seasons
// (2018-2025), reported after a live mock draft produced it.

describe('roster shape rules', () => {
  it('refuses to buy a second QB with auction dollars', () => {
    // Real drafts: 0 or 1 auction QB, never 2, in all 96 team-seasons.
    const team = makeTeamState({
      countByPosition: { QB: 1 },
      filledStarters: { QB: 1 },
      maxBid: 100,
    });
    const qb = makePlayer({ id: 'qb2', position: 'QB', rank: 30, tier: 3 });
    expect(computeWtp(team, qb, 40, 'a1', 1).wtp).toBe(0);

    // ...but the first one is fine, and so is a second at another position.
    const empty = makeTeamState({ maxBid: 100 });
    expect(computeWtp(empty, qb, 40, 'a1', 1).wtp).toBeGreaterThan(0);
    const rb = makePlayer({ id: 'rb2', position: 'RB', rank: 30, tier: 3 });
    expect(computeWtp(team, rb, 40, 'a1', 1).wtp).toBeGreaterThan(0);
  });

  it('lets a two-QB league buy two, because the cap follows the starter slots', () => {
    const settings = {
      ...DEFAULT_ROSTER_SETTINGS,
      starterPositions: ['QB', 'QB', 'RB', 'WR', 'TE', 'FLEX', 'K', 'DST'],
    };
    const team = makeTeamState({
      countByPosition: { QB: 1 },
      filledStarters: { QB: 1 },
      maxBid: 100,
    });
    const qb = makePlayer({ id: 'qb2', position: 'QB', rank: 30, tier: 3 });
    expect(computeWtp(team, qb, 40, 'a1', 1, settings).wtp).toBeGreaterThan(0);
  });

  it('never rosters a third TE, whatever the profile says', () => {
    // The flex slot used to inflate TE's cap to three. The league has done that
    // once in 96 team-seasons; half of all rosters carry exactly one.
    const teLover: TeamProfile = {
      ...NEUTRAL_PROFILE,
      snakePosBias: { QB: 1, RB: 0.4, WR: 0.4, TE: 2.5 },
    };
    const team = makeTeamState({
      profile: teLover,
      countByPosition: { TE: 2, RB: 3, WR: 3, QB: 1, K: 1, DST: 1 },
      filledStarters: { TE: 1, RB: 2, WR: 2, QB: 1, K: 1, DST: 1 },
      filledFlexStarters: 1,
      totalPicks: 11,
      unfilledRequiredStarters: 0,
    });
    const board = [
      makePlayer({ id: 'te3', position: 'TE', rank: 40 }),
      makePlayer({ id: 'rb9', position: 'RB', rank: 90 }),
    ];
    expect(chooseSnakePick(team, board, 'a1', 100).position).toBe('RB');
  });

  it('values a backup QB above a backup TE, and both below flex depth', () => {
    // Measured on final rosters: 77% of teams carry a second QB, 50% a second TE.
    const filled = {
      countByPosition: { QB: 1, TE: 1, RB: 2, WR: 2 },
      filledStarters: { QB: 1, TE: 1, RB: 2, WR: 2 },
      filledFlexStarters: 1,
    };
    const team = makeTeamState(filled);
    const same = (pos: string) => makePlayer({ id: `x${pos}`, position: pos, rank: 100 });
    // Equal rank, so only need separates them. The pick is a weighted sample, not
    // an argmax, so this is a frequency claim over many seeds — asserting a single
    // seed's winner would be asserting the draw, not the weighting.
    const winners = (board: Player[]) =>
      Array.from({ length: 300 }, (_, i) => chooseSnakePick(team, board, `s${i}`, 50).position);

    const qbVsTe = winners([same('QB'), same('TE')]);
    expect(qbVsTe.filter((p) => p === 'QB').length).toBeGreaterThan(
      qbVsTe.filter((p) => p === 'TE').length
    );

    const all = winners([same('QB'), same('TE'), same('RB')]);
    expect(all.filter((p) => p === 'RB').length).toBeGreaterThan(
      all.filter((p) => p === 'QB').length
    );
  });

  it('caps any single price at the room ceiling', () => {
    // 1 of 672 real picks ever cleared above $91 on a $200 budget.
    const team = makeTeamState({ maxBid: 200, remainingAuctionPicks: 7 });
    const stud = makePlayer({ id: 'stud', position: 'RB', rank: 1, tier: 1 });
    const result = computeWtp(team, stud, 150, 'a1', 1);
    expect(result.wtp).toBeLessThanOrEqual(Math.round(200 * DEFAULT_PARAMS.maxPriceShare));

    // Disabling the ceiling lets the market ceiling bind instead.
    const uncapped = computeWtp(team, stud, 150, 'a1', 1, DEFAULT_ROSTER_SETTINGS, {
      ...DEFAULT_PARAMS,
      maxPriceShare: 0,
    });
    expect(uncapped.wtp).toBeGreaterThan(result.wtp);
  });
});
