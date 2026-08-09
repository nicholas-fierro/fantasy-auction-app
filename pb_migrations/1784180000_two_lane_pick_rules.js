/// <reference path="../pb_data/types.d.ts" />
//
// Multi-user step 3: two-lane draft-pick authorization + league-member reads
// (docs/multi-user-plan.md). Builds on 1784100000_api_rules_lockdown.js and
// 1784160000_leagues.js.
//
// Canonical copy lives in the app repo (pb_migrations/); a copy must be placed in
// the PocketBase instance's pb_migrations/ directory, where it auto-applies on
// `pocketbase serve`.
//
// The write model this encodes (hybrid draft entry):
//   - the auction owner keeps full control of their own auctions (mocks stay
//     exactly as before)
//   - the league commissioner can write picks for ANY team in the league's
//     auctions — they run the draft and cover teams not using the app
//   - a league member bound to a team can write picks for THEIR OWN team in
//     the league's official active auctions — no rule lets them touch another
//     team, regardless of what the UI shows
//   - all league members can READ official auctions, their team order, and
//     their picks (live draft spectating via the existing SSE realtime sync);
//     mock auctions remain private to their owner
//   - pick update/delete (price edits, undo) stays owner/commissioner-only
//     (AD-10 intent)
//
// Also tightens reference data: fantasy_teams writes and players /
// player_seasons writes become commissioner-gated (the CSV import pipeline
// authenticates with the commissioner's token, so imports keep working —
// closes the "any authenticated user can clobber reference data" deviation
// noted in AD-2). Reads stay any-authenticated-user: NFL players/seasons are
// not league secrets, and fantasy_teams reads are needed before membership is
// resolved client-side.
//
// The down() migration restores the 1784100000 lockdown rules exactly.

// owner, commissioner, or (official auction) league member — the read lane
const AUCTION_READ =
  'auction_id.user = @request.auth.id' +
  ' || auction_id.league.commissioner = @request.auth.id' +
  ' || (auction_id.type = "official" && auction_id.league.league_members_via_league.user ?= @request.auth.id)';

const NEW_RULES = {
  auctions: {
    listRule:
      'user = @request.auth.id' +
      ' || league.commissioner = @request.auth.id' +
      ' || (type = "official" && league.league_members_via_league.user ?= @request.auth.id)',
    viewRule:
      'user = @request.auth.id' +
      ' || league.commissioner = @request.auth.id' +
      ' || (type = "official" && league.league_members_via_league.user ?= @request.auth.id)',
    // Anyone can create their own mocks; official auctions require being the
    // league's commissioner (createAuction sets `league` from the creator's
    // membership).
    createRule:
      '@request.auth.id != "" && user = @request.auth.id' +
      ' && (type != "official" || league.commissioner = @request.auth.id)',
    updateRule: 'user = @request.auth.id || league.commissioner = @request.auth.id',
    deleteRule: 'user = @request.auth.id || league.commissioner = @request.auth.id',
  },
  draft_picks: {
    listRule: AUCTION_READ,
    viewRule: AUCTION_READ,
    // Two write lanes: owner/commissioner for any team; a member only for the
    // team their league_members row binds them to, only in official auctions
    // of the team's own league. pick_order is server-assigned
    // (pb_hooks/draft_picks_pick_order.pb.js) so the lanes can't race.
    createRule:
      '@request.auth.id != "" && auction_id.status = "active" && (' +
      'auction_id.user = @request.auth.id' +
      ' || auction_id.league.commissioner = @request.auth.id' +
      ' || (auction_id.type = "official"' +
      ' && fantasy_team_id.league = auction_id.league' +
      ' && fantasy_team_id.league_members_via_fantasy_team.user ?= @request.auth.id)' +
      ')',
    updateRule:
      'auction_id.status = "active" && (auction_id.user = @request.auth.id || auction_id.league.commissioner = @request.auth.id)',
    deleteRule:
      'auction_id.status = "active" && (auction_id.user = @request.auth.id || auction_id.league.commissioner = @request.auth.id)',
  },
  auction_teams: {
    listRule: AUCTION_READ,
    viewRule: AUCTION_READ,
    createRule:
      '@request.auth.id != "" && (auction_id.user = @request.auth.id || auction_id.league.commissioner = @request.auth.id)',
    updateRule:
      '(auction_id.user = @request.auth.id || auction_id.league.commissioner = @request.auth.id) && auction_id.status = "active"',
    deleteRule:
      'auction_id.user = @request.auth.id || auction_id.league.commissioner = @request.auth.id',
  },
  // Reference data: reads stay any-authed; writes require being a league
  // commissioner. fantasy_teams created by the import pipeline may not have a
  // league yet, hence the league = "" escape hatch on create.
  fantasy_teams: {
    listRule: '@request.auth.id != ""',
    viewRule: '@request.auth.id != ""',
    createRule:
      '@request.auth.id != "" && (league = "" || league.commissioner = @request.auth.id)' +
      ' && @collection.leagues.commissioner ?= @request.auth.id',
    updateRule: 'league.commissioner = @request.auth.id',
    deleteRule: 'league.commissioner = @request.auth.id',
  },
  players: {
    listRule: '@request.auth.id != ""',
    viewRule: '@request.auth.id != ""',
    createRule: '@collection.leagues.commissioner ?= @request.auth.id',
    updateRule: '@collection.leagues.commissioner ?= @request.auth.id',
    deleteRule: '@collection.leagues.commissioner ?= @request.auth.id',
  },
  player_seasons: {
    listRule: '@request.auth.id != ""',
    viewRule: '@request.auth.id != ""',
    createRule: '@collection.leagues.commissioner ?= @request.auth.id',
    updateRule: '@collection.leagues.commissioner ?= @request.auth.id',
    deleteRule: '@collection.leagues.commissioner ?= @request.auth.id',
  },
};

// The 1784100000_api_rules_lockdown.js rules, restored by down().
const PREVIOUS_RULES = {
  auctions: {
    listRule: 'user = @request.auth.id',
    viewRule: 'user = @request.auth.id',
    createRule: '@request.auth.id != "" && user = @request.auth.id',
    updateRule: 'user = @request.auth.id',
    deleteRule: 'user = @request.auth.id',
  },
  draft_picks: {
    listRule: 'auction_id.user = @request.auth.id',
    viewRule: 'auction_id.user = @request.auth.id',
    createRule:
      '@request.auth.id != "" && auction_id.user = @request.auth.id && auction_id.status = "active"',
    updateRule: 'auction_id.user = @request.auth.id && auction_id.status = "active"',
    deleteRule: 'auction_id.user = @request.auth.id && auction_id.status = "active"',
  },
  auction_teams: {
    listRule: 'auction_id.user = @request.auth.id',
    viewRule: 'auction_id.user = @request.auth.id',
    createRule: '@request.auth.id != "" && auction_id.user = @request.auth.id',
    updateRule: 'auction_id.user = @request.auth.id && auction_id.status = "active"',
    deleteRule: 'auction_id.user = @request.auth.id',
  },
  fantasy_teams: {
    listRule: '@request.auth.id != ""',
    viewRule: '@request.auth.id != ""',
    createRule: '@request.auth.id != ""',
    updateRule: '@request.auth.id != ""',
    deleteRule: '@request.auth.id != ""',
  },
  players: {
    listRule: '@request.auth.id != ""',
    viewRule: '@request.auth.id != ""',
    createRule: '@request.auth.id != ""',
    updateRule: '@request.auth.id != ""',
    deleteRule: '@request.auth.id != ""',
  },
  player_seasons: {
    listRule: '@request.auth.id != ""',
    viewRule: '@request.auth.id != ""',
    createRule: '@request.auth.id != ""',
    updateRule: '@request.auth.id != ""',
    deleteRule: '@request.auth.id != ""',
  },
};

function applyRules(app, rules) {
  for (const [name, ruleSet] of Object.entries(rules)) {
    const collection = app.findCollectionByNameOrId(name);
    collection.listRule = ruleSet.listRule;
    collection.viewRule = ruleSet.viewRule;
    collection.createRule = ruleSet.createRule;
    collection.updateRule = ruleSet.updateRule;
    collection.deleteRule = ruleSet.deleteRule;
    app.save(collection);
  }
}

migrate((app) => {
  applyRules(app, NEW_RULES);
}, (app) => {
  applyRules(app, PREVIOUS_RULES);
});
