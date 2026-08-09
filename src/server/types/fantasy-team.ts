export interface FantasyTeam {
  id: string;
  name: string;
  draft_order: number;
  created: string;
  updated: string;
}

export interface BulkUpdateDraftOrder {
  fantasy_team_id: string;
  draft_order: number;
}
