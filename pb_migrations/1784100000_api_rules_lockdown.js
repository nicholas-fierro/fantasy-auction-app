/// <reference path="../pb_data/types.d.ts" />
//
// Phase 1 of the direct-PocketBase-client rewrite: lock down API rules.
//
// Until now every collection had open (empty-string) rules and authorization
// lived entirely in the Next.js server actions. The rewrite moves reads and most
// writes into the browser talking to PocketBase directly, so PocketBase's own API
// rules become the authorization layer. This migration installs the per-collection
// rules that replace the server-side `assertAuctionOwned` / `assertAuctionActive`
// guards and the per-user query scoping.
//
// Canonical copy lives in the app repo (pb_migrations/); a copy must be placed in
// the PocketBase instance's pb_migrations/ directory, where it auto-applies on
// `pocketbase serve`. Restart PB after adding it (schema is cached in memory).
//
// DEVIATION from the original lockdown plan:
//   The plan calls for players / player_seasons / fantasy_teams writes to be
//   superuser-only (null rule). But the server-side CSV import pipeline
//   (src/server/lib/import-core.ts) authenticates with the logged-in USER's token
//   (from the pb_auth cookie), NOT as a superuser. A null write rule would break
//   imports. This is a single-user-class app, so those writes use
//   `@request.auth.id != ""` instead — any authenticated user may write reference
//   data. Reads are likewise `@request.auth.id != ""` (shared reference data).
//
// The down() migration restores fully-open ("") rules on every touched
// collection so Phase 1 stays reversible during cutover.
//
// Does NOT touch the debt-mgmt-app collections that share this instance.

const AUTHED = '@request.auth.id != ""';

// The rule sets keyed by collection name.
const LOCKED_RULES = {
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
    createRule: '@request.auth.id != "" && auction_id.user = @request.auth.id && auction_id.status = "active"',
    updateRule: 'auction_id.user = @request.auth.id && auction_id.status = "active"',
    deleteRule: 'auction_id.user = @request.auth.id && auction_id.status = "active"',
  },
  auction_teams: {
    listRule: 'auction_id.user = @request.auth.id',
    viewRule: 'auction_id.user = @request.auth.id',
    // Created during auction creation (server action, auction is active); reorders
    // only allowed while the auction is active.
    createRule: '@request.auth.id != "" && auction_id.user = @request.auth.id',
    updateRule: 'auction_id.user = @request.auth.id && auction_id.status = "active"',
    deleteRule: 'auction_id.user = @request.auth.id',
  },
  watchlist: {
    listRule: 'user = @request.auth.id',
    viewRule: 'user = @request.auth.id',
    createRule: '@request.auth.id != "" && user = @request.auth.id',
    updateRule: 'user = @request.auth.id',
    deleteRule: 'user = @request.auth.id',
  },
  // Shared reference data. Writes are authed-user (not superuser) so the
  // user-token import pipeline keeps working — see DEVIATION note above.
  players: {
    listRule: AUTHED,
    viewRule: AUTHED,
    createRule: AUTHED,
    updateRule: AUTHED,
    deleteRule: AUTHED,
  },
  player_seasons: {
    listRule: AUTHED,
    viewRule: AUTHED,
    createRule: AUTHED,
    updateRule: AUTHED,
    deleteRule: AUTHED,
  },
  fantasy_teams: {
    listRule: AUTHED,
    viewRule: AUTHED,
    createRule: AUTHED,
    updateRule: AUTHED,
    deleteRule: AUTHED,
  },
  // Auth collection. Self-only for everything; close the previously-open create
  // rule (REST signup) — flagged as a pre-deploy blocker.
  users: {
    listRule: 'id = @request.auth.id',
    viewRule: 'id = @request.auth.id',
    createRule: null,
    updateRule: 'id = @request.auth.id',
    deleteRule: 'id = @request.auth.id',
  },
};

const OPEN_RULES = {
  listRule: '',
  viewRule: '',
  createRule: '',
  updateRule: '',
  deleteRule: '',
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
  applyRules(app, LOCKED_RULES);
}, (app) => {
  // down: restore open rules on every collection this migration touched.
  const restored = {};
  for (const name of Object.keys(LOCKED_RULES)) {
    restored[name] = OPEN_RULES;
  }
  applyRules(app, restored);
});
