import { describe, expect, it } from 'vitest';
import { normalizeName, rankingFields } from '@/server/lib/import-core';

// Shared facts survive partial CSVs; deltas do not, because pairing an old
// delta with a newly imported rank would invent ADP.
describe('rankingFields', () => {
  const fullColumns = new Set([
    'PLAYER NAME',
    'TEAM',
    'POS',
    'RK',
    'TIERS',
    'BYE WEEK',
    'SOS SEASON',
    'ECR VS. ADP',
  ]);

  it('maps every column of a full export row', () => {
    const fields = rankingFields(
      {
        'PLAYER NAME': "Ja'Marr Chase",
        TEAM: 'CIN',
        POS: 'WR1',
        RK: '1',
        TIERS: '1',
        'BYE WEEK': '10',
        'SOS SEASON': '3 out of 5 stars',
        'ECR VS. ADP': '-2',
      },
      fullColumns,
      'half'
    );

    expect(fields).toEqual({
      team: 'CIN',
      position_rank: 1,
      rank: 1,
      tier: 1,
      bye_week: 10,
      sos: 3,
      ecr_vs_adp: -2,
      ecr_vs_adp_known: true,
    });
  });

  it('writes standard rankings to the legacy ranking columns', () => {
    const fields = rankingFields(
      { POS: 'RB2', RK: '7', TIERS: '3', 'ECR VS. ADP': '+1' },
      new Set(['POS', 'RK', 'TIERS', 'ECR VS. ADP']),
      'std'
    );

    expect(fields).toEqual({
      position_rank: 2,
      rank: 7,
      tier: 3,
      ecr_vs_adp: 1,
      ecr_vs_adp_known: true,
    });
  });

  it('writes a full-PPR board without touching half-PPR ranking columns', () => {
    const fields = rankingFields(
      {
        'PLAYER NAME': "Ja'Marr Chase",
        TEAM: 'CIN',
        POS: 'WR1',
        RK: '1',
        TIERS: '1',
        'BYE WEEK': '10',
        'SOS SEASON': '3 out of 5 stars',
        'ECR VS. ADP': '-2',
      },
      fullColumns,
      'ppr'
    );

    expect(fields).toEqual({
      team: 'CIN',
      position_rank_ppr: 1,
      rank_ppr: 1,
      tier_ppr: 1,
      bye_week: 10,
      sos: 3,
      ecr_vs_adp_ppr: -2,
      ecr_vs_adp_ppr_known: true,
    });
    expect(fields).not.toHaveProperty('position_rank');
    expect(fields).not.toHaveProperty('rank');
    expect(fields).not.toHaveProperty('tier');
    expect(fields).not.toHaveProperty('ecr_vs_adp');
  });

  it('omits columns the CSV does not have, so an update cannot blank them', () => {
    const columns = new Set(['PLAYER NAME', 'TEAM', 'POS', 'RK', 'TIERS', 'BYE WEEK']);
    const fields = rankingFields(
      {
        'PLAYER NAME': 'Jahmyr Gibbs',
        TEAM: 'DET',
        POS: 'RB1',
        RK: '1',
        TIERS: '1',
        'BYE WEEK': '6',
      },
      columns,
      'half'
    );

    expect(fields).not.toHaveProperty('sos');
    expect(fields).toEqual({ team: 'DET', position_rank: 1, rank: 1, tier: 1, bye_week: 6,
      ecr_vs_adp: 0, ecr_vs_adp_known: false });
  });

  it('still writes 0 for a present column with an empty cell', () => {
    const fields = rankingFields(
      {
        'PLAYER NAME': 'Someone',
        TEAM: '',
        POS: 'WR40',
        RK: '',
        TIERS: '',
        'BYE WEEK': '',
        'SOS SEASON': '',
        'ECR VS. ADP': '',
      },
      fullColumns,
      'half'
    );

    expect(fields).toEqual({
      team: '',
      position_rank: 40,
      rank: 0,
      tier: 0,
      bye_week: 0,
      sos: 0,
      ecr_vs_adp: 0,
      ecr_vs_adp_known: false,
    });
  });
});

describe('normalizeName', () => {
  it.each([
    ['Ken Walker III', 'Kenneth Walker III'],
    ['Marquise Brown', 'Hollywood Brown'],
    ['Josh Palmer', 'Joshua Palmer'],
    ['Chigoziem Okonkwo', 'Chig Okonkwo'],
    ['Kenneth Gainwell', 'Kenny Gainwell'],
    ['Gabriel Davis', 'Gabe Davis'],
    ['Lamical Perine', "La'Mical Perine"],
    ['Zonovan Knight', 'Bam Knight'],
    ['Olabisi Johnson', 'Bisi Johnson'],
    ['Scott Miller', 'Scotty Miller'],
    ["D'Wayne Eskridge", 'Dee Eskridge'],
    ['William Fuller V', 'Will Fuller'],
    ['Steven Hauschka', 'Stephen Hauschka'],
    ['Benjamin Watson', 'Ben Watson'],
    ['Robbie Anderson', 'Robbie Chosen'],
    ['Robby Anderson', 'Robbie Chosen'],
    ['Mitch Trubisky', 'Mitchell Trubisky'],
    ['Deonte Harris', 'Deonte Harty'],
    ['P.J. Walker', 'Phillip Walker'],
  ])('maps %s to canonical %s', (alias, canonical) => {
    expect(normalizeName(alias)).toBe(normalizeName(canonical));
  });
});
