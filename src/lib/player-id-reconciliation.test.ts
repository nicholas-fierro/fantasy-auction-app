import { describe, expect, it } from 'vitest';
import {
  planPlayerIdReconciliation,
  type CrosswalkIdentity,
  type PlayerIdentity,
} from '../../scripts/sync-player-ids';

describe('planPlayerIdReconciliation', () => {
  it('fills missing IDs from deterministic matches without guessing conflicts', () => {
    const crosswalk: CrosswalkIdentity[] = [
      {
        name: 'Patrick Mahomes',
        position: 'QB',
        gsis_id: '00-0033873',
        fantasypros_id: '16413',
        sleeper_id: '4046',
        espn_id: '3139477',
      },
      {
        name: 'Joe Burrow',
        position: 'QB',
        gsis_id: '00-0036442',
        fantasypros_id: '18635',
        sleeper_id: '6770',
        espn_id: '3915511',
      },
    ];
    const players: PlayerIdentity[] = [
      {
        id: 'mahomes',
        name: 'Patrick Mahomes II',
        position: 'QB',
        fantasypros_id: '16413',
      },
      { id: 'burrow', name: 'Joe Burrow', position: 'QB' },
      {
        id: 'conflict',
        name: 'Wrong IDs',
        position: 'QB',
        sleeper_id: '4046',
        espn_id: '3915511',
      },
      {
        id: 'unknown',
        name: 'Patrick Mahomes',
        position: 'QB',
        sleeper_id: 'not-in-crosswalk',
      },
    ];

    const plan = planPlayerIdReconciliation(players, crosswalk);

    expect(plan.updates).toEqual([
      {
        id: 'mahomes',
        name: 'Patrick Mahomes II',
        via: 'id',
        data: { gsis_id: '00-0033873', sleeper_id: '4046', espn_id: '3139477' },
      },
      {
        id: 'burrow',
        name: 'Joe Burrow',
        via: 'name',
        data: {
          gsis_id: '00-0036442',
          fantasypros_id: '18635',
          sleeper_id: '6770',
          espn_id: '3915511',
        },
      },
    ]);
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.unresolved).toEqual([
      expect.objectContaining({ id: 'unknown', reason: 'existing IDs not found in crosswalk' }),
    ]);
    expect(plan.coverageAfter).toEqual({
      gsis_id: 2,
      fantasypros_id: 2,
      sleeper_id: 4,
      espn_id: 3,
    });
  });

  it('accepts reviewed historical position transitions', () => {
    const crosswalk: CrosswalkIdentity[] = [
      { name: 'Rondale Moore', position: 'XX', gsis_id: 'rondale' },
      { name: 'JJ Arcega-Whiteside', position: 'TE', gsis_id: 'jjaw' },
      { name: 'Brady Russell', position: 'RB', gsis_id: 'brady' },
      { name: 'Kelvin Benjamin', position: 'TE', gsis_id: 'kelvin' },
    ];
    const players: PlayerIdentity[] = [
      { id: 'rondale', name: 'Rondale Moore', position: 'WR', gsis_id: 'rondale' },
      { id: 'jjaw', name: 'J.J. Arcega-Whiteside', position: 'WR', gsis_id: 'jjaw' },
      { id: 'brady', name: 'Brady Russell', position: 'TE', gsis_id: 'brady' },
      { id: 'kelvin', name: 'Kelvin Benjamin', position: 'WR', gsis_id: 'kelvin' },
    ];

    const plan = planPlayerIdReconciliation(players, crosswalk);

    expect(plan.conflicts).toEqual([]);
    expect(plan.unresolved).toEqual([]);
    expect(plan.matchedById).toBe(4);
  });
});
