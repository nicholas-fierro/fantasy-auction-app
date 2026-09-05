// Shared shapes for the in-app CSV import flow.

import type { ScoringFormat } from '@/lib/fantasy-scoring';

// A row from a CSV that could not be matched to a player identity (or to a
// season row, for rookies). Surfaced in the per-file import report.
export interface UnmatchedRow {
  name: string;
  team: string;
  position: string;
}

// A row that matched more than one player identity and could not be
// disambiguated by team — reported and skipped, never guessed.
export interface AmbiguousRow {
  name: string;
  team: string;
  position: string;
  matches: number;
}

// A row that matched a player identity only via the normalized-name pass
// (pass 2) rather than an exact name match — surfaced so the CSV name can be
// checked against the matched identity.
export interface FuzzyRow {
  csvName: string;
  matchedName: string;
  position: string;
}

export interface ImportReport {
  created: number;
  updated: number;
  skipped: number;
  unmatched: UnmatchedRow[];
  ambiguous: AmbiguousRow[];
  fuzzy: FuzzyRow[];
}

export interface ImportInput {
  year: number;
  csvText: string;
}

export type RankingScoringFormat = Extract<ScoringFormat, 'half' | 'ppr'>;

export interface RankingImportCoreInput extends ImportInput {
  scoringFormat: RankingScoringFormat;
}

export interface RankingImportInput extends RankingImportCoreInput {
  leagueId: string;
}

// Result of matching app players to their external provider IDs
// (src/server/lib/player-ids.ts). `ambiguous` and `unmatched` are Sleeper-side
// only — the FantasyPros pass has no tiebreaker, so a miss is just a miss.
export interface PlayerIdSyncReport {
  playersScanned: number;
  sleeperMatched: number;
  espnBackfilled: number;
  fantasyProsMatched: number;
  fantasyProsUnmatched: number;
  written: number;
  ambiguous: { name: string; position: string; candidates: number }[];
  unmatched: { name: string; position: string }[];
}

// One row of the recalculation preview — the top of the resulting board.
export interface ProjectedValueRow {
  name: string;
  position: string;
  value: number;
  previous: number;
}

// Result of recalculating a year's projected values with the League Value Model.
// `historyYears` are the official auction years the estimates were priced from,
// surfaced so it is obvious what the model had to work with.
export interface CalculateProjectedResult {
  updated: number;
  unchanged: number;
  historyYears: number[];
  top: ProjectedValueRow[];
}
