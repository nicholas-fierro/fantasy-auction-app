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
