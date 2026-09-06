import type { ScoringFormat } from '@/lib/fantasy-scoring';

export type SeasonRankingField = 'position_rank' | 'ecr_vs_adp' | 'rank' | 'tier';

export function seasonRankingFieldName(
  field: SeasonRankingField,
  scoringFormat: ScoringFormat
): SeasonRankingField | `${SeasonRankingField}_ppr` {
  return scoringFormat === 'ppr' ? `${field}_ppr` : field;
}

export function seasonRankingValue(
  record: object,
  field: SeasonRankingField,
  scoringFormat: ScoringFormat
): number {
  const values = record as Record<string, unknown>;
  return Number(values[seasonRankingFieldName(field, scoringFormat)] ?? 0);
}

// PocketBase number fields default to zero. Only the explicit presence marker
// distinguishes an imported zero delta from an empty cell or an absent board.
export function seasonEcrVsAdpValue(
  record: object,
  scoringFormat: ScoringFormat
): number | null {
  const values = record as Record<string, unknown>;
  const field = seasonRankingFieldName('ecr_vs_adp', scoringFormat);
  const value = values[field];
  return values[`${field}_known`] === true && typeof value === 'number' && Number.isFinite(value)
    ? value
    : null;
}
