/// <reference path="../pb_data/types.d.ts" />
//
// Fix stale watchlist uniqueness constraint after per-user watchlists.
//
// Canonical copy lives in the app repo (pb_migrations/); a copy must be placed in
// the PocketBase instance's pb_migrations/ directory, where it auto-applies on
// `pocketbase serve`.
//
// Background:
//   `idx_UkVzg4Tflo` (UNIQUE on player_id, fantasy_team_id) predates per-user
//   watchlists. Since 1783900000_users_auth.js made `fantasy_team_id` optional,
//   new rows store fantasy_team_id="" and this index wrongly treats all such
//   rows for the same player as duplicates across different users, blocking
//   adds to the watchlist for anyone after the first user to star a player.
//
// Fix: replace it with a unique index on (player_id, user) so uniqueness is
// scoped per user instead of per fantasy team.
migrate((app) => {
  const collection = app.findCollectionByNameOrId("watchlist");

  const staleIndex = "CREATE UNIQUE INDEX `idx_UkVzg4Tflo` ON `watchlist` (\n  `player_id`,\n  `fantasy_team_id`\n)";
  const newIndex = "CREATE UNIQUE INDEX `idx_watchlist_player_user` ON `watchlist` (\n  `player_id`,\n  `user`\n)";

  if (!collection.indexes.includes(newIndex)) {
    collection.indexes = collection.indexes
      .filter((idx) => idx !== staleIndex)
      .concat([newIndex]);
    app.save(collection);
  }
}, (app) => {
  const collection = app.findCollectionByNameOrId("watchlist");

  const staleIndex = "CREATE UNIQUE INDEX `idx_UkVzg4Tflo` ON `watchlist` (\n  `player_id`,\n  `fantasy_team_id`\n)";
  const newIndex = "CREATE UNIQUE INDEX `idx_watchlist_player_user` ON `watchlist` (\n  `player_id`,\n  `user`\n)";

  if (!collection.indexes.includes(staleIndex)) {
    collection.indexes = collection.indexes
      .filter((idx) => idx !== newIndex)
      .concat([staleIndex]);
    app.save(collection);
  }
});
