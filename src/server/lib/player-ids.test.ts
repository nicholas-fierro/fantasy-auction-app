import { describe, expect, it } from 'vitest';
import type { RecordModel } from 'pocketbase';
import {
  buildFantasyProsIdIndex,
  buildIdWrites,
  buildSleeperIndex,
  matchFantasyProsId,
  matchSleeperIds,
  parseDpEspnMap,
  type SleeperDump,
  type SleeperMatch,
} from '@/server/lib/player-ids';

const player = (over: Partial<RecordModel> & { name: string; position: string }): RecordModel =>
  ({ id: `id-${over.name}`, sleeper_id: '', espn_id: '', fantasypros_id: '', ...over }) as RecordModel;

const entry = (over: Partial<SleeperDump[string]> = {}) => ({
  search_full_name: 'jamarrchase',
  position: 'WR',
  team: 'CIN',
  espn_id: 4362628,
  active: true,
  ...over,
});

describe('matchSleeperIds', () => {
  it('matches a unique same-position candidate and takes its espn_id', () => {
    const index = buildSleeperIndex({ '7564': entry() });
    const result = matchSleeperIds(
      [player({ name: "Ja'Marr Chase", position: 'WR' })],
      index,
      new Map(),
      new Map()
    );

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]).toMatchObject({ sleeperId: '7564', espnId: '4362628' });
    expect(result.unmatched).toEqual([]);
  });

  it('falls back to the DynastyProcess map when Sleeper has no espn_id', () => {
    const index = buildSleeperIndex({ '7564': entry({ espn_id: null }) });
    const result = matchSleeperIds(
      [player({ name: "Ja'Marr Chase", position: 'WR' })],
      index,
      new Map(),
      new Map([['7564', '99999']])
    );

    expect(result.matches[0].espnId).toBe('99999');
  });

  it('breaks a same-name tie on the latest known team', () => {
    const index = buildSleeperIndex({
      a: entry({ search_full_name: 'mikewilliams', team: 'LAC', espn_id: 1 }),
      b: entry({ search_full_name: 'mikewilliams', team: 'NYJ', espn_id: 2 }),
    });
    const target = player({ name: 'Mike Williams', position: 'WR' });
    const result = matchSleeperIds([target], index, new Map([[target.id, 'NYJ']]), new Map());

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].sleeperId).toBe('b');
    expect(result.matches[0].viaTeamTiebreak).toBe(true);
    expect(result.teamTiebreaks).toBe(1);
  });

  it('falls back to the active candidate when no team is known', () => {
    const index = buildSleeperIndex({
      a: entry({ search_full_name: 'mikewilliams', team: 'LAC', active: false }),
      b: entry({ search_full_name: 'mikewilliams', team: 'NYJ', active: true }),
    });
    const result = matchSleeperIds(
      [player({ name: 'Mike Williams', position: 'WR' })],
      index,
      new Map(),
      new Map()
    );

    expect(result.matches[0].sleeperId).toBe('b');
    expect(result.matches[0].viaTeamTiebreak).toBe(false);
  });

  it('reports an unresolvable tie rather than guessing', () => {
    const index = buildSleeperIndex({
      a: entry({ search_full_name: 'mikewilliams', team: 'LAC', active: true }),
      b: entry({ search_full_name: 'mikewilliams', team: 'NYJ', active: true }),
    });
    const result = matchSleeperIds(
      [player({ name: 'Mike Williams', position: 'WR' })],
      index,
      new Map(),
      new Map()
    );

    expect(result.matches).toEqual([]);
    expect(result.ambiguous).toEqual([{ name: 'Mike Williams', position: 'WR', candidates: 2 }]);
  });

  it('applies name aliases and folds FB into RB', () => {
    const index = buildSleeperIndex({
      fb: entry({ search_full_name: 'kylejuszczyk', position: 'FB', team: 'SF' }),
      alias: entry({ search_full_name: 'marquisebrown', position: 'WR', team: 'KC' }),
    });
    const result = matchSleeperIds(
      [
        player({ name: 'Kyle Juszczyk', position: 'RB' }),
        player({ name: 'Hollywood Brown', position: 'WR' }),
      ],
      index,
      new Map(),
      new Map()
    );

    expect(result.matches.map((m) => m.sleeperId).sort()).toEqual(['alias', 'fb']);
  });

  it('skips DST, and skips players that already have an id unless forced', () => {
    const index = buildSleeperIndex({ '7564': entry() });
    const existing = player({ name: "Ja'Marr Chase", position: 'WR', sleeper_id: '7564', espn_id: '1' });
    const result = matchSleeperIds(
      [existing, player({ name: 'Bears', position: 'DST' })],
      index,
      new Map(),
      new Map()
    );

    expect(result.skippedDst).toBe(1);
    expect(result.alreadyHadId).toBe(1);
    expect(result.matches).toEqual([]);

    const forced = matchSleeperIds([existing], index, new Map(), new Map(), true);
    expect(forced.matches).toHaveLength(1);
  });

  it('backfills espn_id for a player that already has a sleeper_id but no espn_id', () => {
    const index = buildSleeperIndex({ '7564': entry() });
    const result = matchSleeperIds(
      [player({ name: "Ja'Marr Chase", position: 'WR', sleeper_id: '7564', espn_id: '' })],
      index,
      new Map(),
      new Map([['7564', '4362628']])
    );

    expect(result.matches).toEqual([]);
    expect(result.espnBackfills).toHaveLength(1);
    expect(result.espnBackfills[0].espnId).toBe('4362628');
  });
});

describe('buildIdWrites', () => {
  const match = (over: Partial<SleeperMatch> = {}): SleeperMatch => ({
    id: 'id-p',
    name: 'P',
    sleeperId: '7564',
    espnId: '4362628',
    viaTeamTiebreak: false,
    ...over,
  });

  it('never blanks an existing espn_id when no mapping was found', () => {
    const players = [player({ name: 'P', position: 'WR', sleeper_id: '', espn_id: '111' })];
    const writes = buildIdWrites(players, [match({ id: players[0].id, espnId: '' })]);

    expect(writes.get(players[0].id)).toEqual({ sleeper_id: '7564' });
    expect(writes.get(players[0].id)).not.toHaveProperty('espn_id');
  });

  it('leaves an existing espn_id alone rather than overwriting it', () => {
    const players = [player({ name: 'P', position: 'WR', sleeper_id: '', espn_id: '111' })];
    const writes = buildIdWrites(players, [match({ id: players[0].id, espnId: '999' })]);

    expect(writes.get(players[0].id)).toEqual({ sleeper_id: '7564' });
  });

  it('fills both when both are blank', () => {
    const players = [player({ name: 'P', position: 'WR' })];
    const writes = buildIdWrites(players, [match({ id: players[0].id })]);

    expect(writes.get(players[0].id)).toEqual({ sleeper_id: '7564', espn_id: '4362628' });
  });

  it('re-derives both under force, but still never writes an empty id', () => {
    const players = [player({ name: 'P', position: 'WR', sleeper_id: 'old', espn_id: '111' })];

    expect(buildIdWrites(players, [match({ id: players[0].id, espnId: '999' })], true).get(players[0].id))
      .toEqual({ sleeper_id: '7564', espn_id: '999' });

    expect(buildIdWrites(players, [match({ id: players[0].id, espnId: '' })], true).get(players[0].id))
      .toEqual({ sleeper_id: '7564' });
  });

  it('emits no write at all when there is nothing to fill', () => {
    const players = [player({ name: 'P', position: 'WR', sleeper_id: '7564', espn_id: '4362628' })];
    const writes = buildIdWrites(players, [match({ id: players[0].id })]);

    expect(writes.size).toBe(0);
  });
});

describe('buildSleeperIndex', () => {
  it('drops entries outside the matchable positions, and entries with no search key', () => {
    const index = buildSleeperIndex({
      a: entry({ search_full_name: 'somekicker', position: 'K' }),
      b: entry({ search_full_name: 'somedefense', position: 'DEF' }),
      c: entry({ search_full_name: '', position: 'WR' }),
    });

    expect([...index.keys()]).toEqual(['somekicker']);
  });
});

describe('buildFantasyProsIdIndex', () => {
  const csv = (rows: string) => `player,id,pos\n${rows}`;

  it('maps a name+position to its id', () => {
    const index = buildFantasyProsIdIndex(csv('Bijan Robinson,22970,RB\n'));
    expect(matchFantasyProsId(index, 'Bijan Robinson', 'RB')).toBe('22970');
  });

  it('drops a name+position that maps to two different ids', () => {
    const index = buildFantasyProsIdIndex(csv('Mike Williams,1,WR\nMike Williams,2,WR\n'));
    expect(matchFantasyProsId(index, 'Mike Williams', 'WR')).toBeNull();
  });

  it('ignores rows with a non-numeric id', () => {
    const index = buildFantasyProsIdIndex(csv('Ghost Player,abc,WR\n'));
    expect(index.size).toBe(0);
  });
});

describe('parseDpEspnMap', () => {
  it('keeps only rows with both ids', () => {
    const map = parseDpEspnMap('sleeper_id,espn_id\n7564,4362628\n123,\n,999\n');
    expect([...map.entries()]).toEqual([['7564', '4362628']]);
  });
});
