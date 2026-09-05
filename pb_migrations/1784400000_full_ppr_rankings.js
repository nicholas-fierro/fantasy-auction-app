/// <reference path="../pb_data/types.d.ts" />
//
// Keep half-PPR and full-PPR ranking boards on one player-season row while the
// player/year uniqueness key remains unchanged. Shared season facts stay on the
// existing fields; only format-dependent ranking fields are duplicated.
//
// This migration also scopes fantasy-team reads to that team's league. The
// empty-league guard must run before changing rules or existing rows could
// become unreachable to every non-superuser caller.

const TEAM_READ =
  '@request.auth.id != "" && (' +
  'league.commissioner = @request.auth.id' +
  ' || league.league_members_via_league.user ?= @request.auth.id' +
  ')';

const TEAM_CREATE =
  '@request.auth.id != "" && league.commissioner = @request.auth.id' +
  ' && @collection.leagues.commissioner ?= @request.auth.id';

const PREVIOUS_TEAM_RULES = {
  listRule: '@request.auth.id != ""',
  viewRule: '@request.auth.id != ""',
  createRule:
    '@request.auth.id != "" && (league = "" || league.commissioner = @request.auth.id)' +
    ' && @collection.leagues.commissioner ?= @request.auth.id',
};

const PPR_FIELDS = [
  'rank_ppr',
  'position_rank_ppr',
  'tier_ppr',
  'ecr_vs_adp_ppr',
];

migrate((app) => {
  const unscopedTeams = app
    .findAllRecords('fantasy_teams')
    .filter((team) => team.getString('league') === '');
  if (unscopedTeams.length > 0) {
    throw new Error(
      `Cannot tighten fantasy_teams rules: ${unscopedTeams.length} team row(s) have no league`
    );
  }

  const seasons = app.findCollectionByNameOrId('player_seasons');
  for (const name of PPR_FIELDS) {
    if (seasons.fields.getByName(name)) continue;
    seasons.fields.add(new Field({
      name,
      type: 'number',
      required: false,
      onlyInt: true,
    }));
  }
  app.save(seasons);

  const teams = app.findCollectionByNameOrId('fantasy_teams');
  teams.listRule = TEAM_READ;
  teams.viewRule = TEAM_READ;
  teams.createRule = TEAM_CREATE;
  app.save(teams);
}, (app) => {
  const teams = app.findCollectionByNameOrId('fantasy_teams');
  teams.listRule = PREVIOUS_TEAM_RULES.listRule;
  teams.viewRule = PREVIOUS_TEAM_RULES.viewRule;
  teams.createRule = PREVIOUS_TEAM_RULES.createRule;
  app.save(teams);

  const seasons = app.findCollectionByNameOrId('player_seasons');
  for (const name of PPR_FIELDS) {
    if (seasons.fields.getByName(name)) seasons.fields.removeByName(name);
  }
  app.save(seasons);
});
