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

// Presence check for a format's board: PocketBase stores absent numbers as 0,
// so a nonzero value in any of the three rank-family columns proves the board
// was imported. A board of all zeros is indistinguishable from no board at
// all — callers treat that as missing, not as a real ranking.
export function seasonBoardImported(
  record: object,
  scoringFormat: ScoringFormat
): boolean {
  const values = record as Record<string, unknown>;
  return (['rank', 'position_rank', 'tier'] as const).some(
    (field) => Number(values[seasonRankingFieldName(field, scoringFormat)] ?? 0) > 0
  );
}
