import { afterEach, describe, expect, it, vi } from 'vitest';
import type PocketBase from 'pocketbase';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildHistory, buildPricedPicks, loadFromDump, loadFromPocketBase } from '@/server/lib/value-data';
import { leagueValueModelConfig } from '@/lib/league-history';
import { DEFAULT_ROSTER_SETTINGS, type RosterSettings } from '@/lib/roster';

function fixture(settings: Partial<RosterSettings> = {}) {
  return {
    leagues: [{ id: 'league-1', settings: { ...DEFAULT_ROSTER_SETTINGS, ...settings } }],
    fantasy_teams: Array.from({ length: 12 }, (_, i) => ({ id: `team-${i}`, league: 'league-1' })),
    auctions: [
      { id: 'older', league: 'league-1', year: 2025, type: 'official', status: 'active', created: '2025-01-01' },
      { id: 'own', league: 'league-1', year: 2025, type: 'official', status: 'completed', created: '2025-01-02' },
      { id: 'foreign', league: 'league-2', year: 2025, type: 'official', status: 'completed', created: '2025-01-03' },
      { id: 'external', league: '', year: 2026, type: 'official', status: 'completed', external: true, created: '2026-01-01' },
    ],
    picks: [
      { auction_id: 'older', player_id: 'player-1', price: 10 },
      { auction_id: 'own', player_id: 'player-1', price: 25 },
      { auction_id: 'foreign', player_id: 'player-1', price: 99 },
      { auction_id: 'external', player_id: 'player-1', price: 30 },
    ],
    seasons: [2025, 2026].flatMap(year => [
      { id: `season-${year}-1`, player_id: 'player-1', year, rank: 12, position_rank: 5, rank_ppr: 3, position_rank_ppr: 2, projected_auction_value: 24 },
      { id: `season-${year}-2`, player_id: 'player-2', year, rank: 13, position_rank: 6, rank_ppr: 4, position_rank_ppr: 3, projected_auction_value: 0 },
    ]),
    players: [{ id: 'player-1', name: 'One', position: 'RB' }, { id: 'player-2', name: 'Two', position: 'RB' }],
  };
}

function fakePocketBase(data = fixture()): PocketBase {
  return {
    filter: vi.fn((_filter: string, values: unknown) => values),
    collection: vi.fn((name: string) => ({
      getOne: vi.fn(async (id: string) => {
        const league = data.leagues.find(row => row.id === id);
        if (!league) throw new Error('League not found');
        return league;
      }),
      getFullList: vi.fn(async (options?: { filter?: { id?: string } }) => {
        if (name === 'draft_picks') return data.picks.filter(pick => pick.auction_id === options?.filter?.id);
        if (name === 'player_seasons') return data.seasons;
        if (name === 'fantasy_teams') return data.fantasy_teams;
        if (name === 'auctions') return data.auctions;
        if (name === 'players') return data.players;
        throw new Error(`Unexpected collection: ${name}`);
      }),
    })),
  } as unknown as PocketBase;
}

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});
function dump(data: unknown): string {
  const directory = mkdtempSync(join(tmpdir(), 'league-values-'));
  temporaryDirectories.push(directory);
  const path = join(directory, 'data.json');
  writeFileSync(path, JSON.stringify(data));
  return path;
}
const options = { leagueId: 'league-1' };

describe('league-scoped model data', () => {
  it.each(['half', 'std', 'ppr'] as const)('uses the selected league %s board', async scoringFormat => {
    const data = await loadFromPocketBase(fakePocketBase(fixture({ scoringFormat })), options);
    expect(data.seasons[0]).toMatchObject(scoringFormat === 'ppr'
      ? { rank: 3, position_rank: 2 } : { rank: 12, position_rank: 5 });
  });
  it('requires a league and rejects a scoring override for another board', async () => {
    await expect(loadFromPocketBase(fakePocketBase(), { leagueId: '' })).rejects.toThrow('league id is required');
    await expect(loadFromPocketBase(fakePocketBase(), { ...options, scoringFormat: 'ppr' })).rejects.toThrow('Selected league uses half');
  });
  it('scopes before collapse and keeps live and offline inputs identical', async () => {
    const raw = fixture();
    const live = await loadFromPocketBase(fakePocketBase(raw), options);
    expect(loadFromDump(dump(raw), options)).toEqual(live);
    expect(live.auctions.map(row => row.id)).toEqual(['own', 'external']);
    expect(live.picks.map(row => row.price)).toEqual([25, 30]);
    expect(buildHistory(live, 2026).map(row => [row.year, row.price, row.external])).toEqual([
      [2025, 25, false], [2025, 0, false], [2026, 30, true], [2026, 0, true],
    ]);
    expect(buildPricedPicks(live, 2025).map(row => row.price)).toEqual([25]);
    expect(buildPricedPicks(live, 2026)).toEqual([]);
  });
  it('rejects offline dumps without league provenance', () => {
    const raw = fixture();
    expect(() => loadFromDump(dump({ ...raw, leagues: undefined }), options)).toThrow('selected league');
    expect(() => loadFromDump(dump({ ...raw, fantasy_teams: undefined }), options)).toThrow('metadata');
    expect(() => loadFromDump(dump(raw), { leagueId: 'missing' })).toThrow('selected league');
  });
  it.each([
    { draftFormat: 'snake' as const, budget: 0, paidAuctionSlots: 0 },
    { budget: 250 }, { paidAuctionSlots: 8 },
  ])('rejects incompatible external boards for %j', async settings => {
    const raw = fixture(settings);
    const data = await loadFromPocketBase(fakePocketBase(raw), options);
    expect(data.auctions.map(row => row.id)).toEqual(['own']);
    expect(loadFromDump(dump(raw), options)).toEqual(data);
  });
  it('rejects external boards when team counts differ', async () => {
    const raw = fixture();
    raw.fantasy_teams.pop();
    const data = await loadFromPocketBase(fakePocketBase(raw), options);
    expect(data.auctions.map(row => row.id)).toEqual(['own']);
  });
  it('never derives snake format from slots or produces snake prices', async () => {
    const data = await loadFromPocketBase(fakePocketBase(fixture({ draftFormat: 'snake' })), options);
    expect(data.auctions.map(row => row.id)).toEqual(['own']);
    expect(buildHistory(data, 2027)).toEqual([]);
    expect(buildPricedPicks(data, 2025)).toEqual([]);
    expect(() => leagueValueModelConfig(data.scope)).toThrow('Snake leagues');
  });
  it('normalizes to league budget and paid slots', async () => {
    const data = await loadFromPocketBase(fakePocketBase(fixture({ budget: 100, paidAuctionSlots: 5 })), options);
    expect(leagueValueModelConfig(data.scope)).toMatchObject({ budget: 1200, draftedPoolSize: 60 });
  });
});
