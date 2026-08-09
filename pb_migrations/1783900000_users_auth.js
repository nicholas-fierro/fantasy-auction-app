/// <reference path="../pb_data/types.d.ts" />
//
// Per-user ownership for multi-user deployment.
//
// Canonical copy lives in the app repo (pb_migrations/); a copy must be placed in
// the PocketBase instance's pb_migrations/ directory, where it auto-applies on
// `pocketbase serve`.
//
// Schema:
//   - `auctions` gains an optional `user` relation (owner; the app scopes all
//     auction queries to the logged-in user)
//   - `watchlist` gains an optional `user` relation and `fantasy_team_id`
//     becomes optional (watchlists are per-user now, not per-fantasy-team)
//
// The `user` fields are optional so pre-auth rows keep validating; the app
// always sets them. Backfill of existing rows to a specific account is a
// one-time manual step (no users exist when this migration first runs).
//
// API rules stay open here; the production lockdown rules ship in a separate
// migration (1784100000_api_rules_lockdown.js) applied to the deployed instance.
migrate((app) => {
  const usersCol = app.findCollectionByNameOrId("users");

  const auctionsCol = app.findCollectionByNameOrId("auctions");
  if (!auctionsCol.fields.getByName("user")) {
    auctionsCol.fields.add(new Field({
      name: "user",
      type: "relation",
      required: false,
      maxSelect: 1,
      cascadeDelete: false,
      collectionId: usersCol.id
    }));
    app.save(auctionsCol);
  }

  const watchlistCol = app.findCollectionByNameOrId("watchlist");
  let watchlistChanged = false;
  if (!watchlistCol.fields.getByName("user")) {
    watchlistCol.fields.add(new Field({
      name: "user",
      type: "relation",
      required: false,
      maxSelect: 1,
      cascadeDelete: true,
      collectionId: usersCol.id
    }));
    watchlistChanged = true;
  }
  const teamField = watchlistCol.fields.getByName("fantasy_team_id");
  if (teamField && teamField.required) {
    teamField.required = false;
    watchlistChanged = true;
  }
  if (watchlistChanged) {
    app.save(watchlistCol);
  }
}, (app) => {
  const auctionsCol = app.findCollectionByNameOrId("auctions");
  if (auctionsCol.fields.getByName("user")) {
    auctionsCol.fields.removeByName("user");
    app.save(auctionsCol);
  }

  const watchlistCol = app.findCollectionByNameOrId("watchlist");
  if (watchlistCol.fields.getByName("user")) {
    watchlistCol.fields.removeByName("user");
    app.save(watchlistCol);
  }
});
