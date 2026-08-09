/// <reference path="../pb_data/types.d.ts" />
//
// Mock draft support.
//
// Canonical copy lives in the app repo (pb_migrations/); a copy must be placed in
// the PocketBase instance's pb_migrations/ directory, where it auto-applies on
// `pocketbase serve`.
//
// Schema:
//   - new `team_profiles` collection — persisted per-team mock-draft profile
//     overrides. One row per (user, fantasy_team_id) pair, enforced by a unique
//     index; `overrides` is a free-form json blob owned by the app layer.
//   - `auctions` gains an optional bool field `sim`, which flags an auction as
//     an AI-simulated mock draft (as opposed to a real live draft). Bool fields
//     default to false when unset, so existing auctions are treated as
//     non-simulated without a backfill.
migrate((app) => {
  const usersCol = app.findCollectionByNameOrId("users");
  const fantasyTeamsCol = app.findCollectionByNameOrId("fantasy_teams");

  // 1. team_profiles collection
  try {
    app.findCollectionByNameOrId("team_profiles");
  } catch (_) {
    const teamProfilesCol = new Collection({
      name: "team_profiles",
      type: "base",
      listRule: "user = @request.auth.id",
      viewRule: "user = @request.auth.id",
      createRule: '@request.auth.id != "" && user = @request.auth.id',
      updateRule: "user = @request.auth.id",
      deleteRule: "user = @request.auth.id",
      indexes: [
        "CREATE UNIQUE INDEX `idx_team_profiles_user_team` ON `team_profiles` (`user`, `fantasy_team_id`)"
      ],
      fields: [
        {
          autogeneratePattern: "[a-z0-9]{15}",
          max: 15,
          min: 15,
          name: "id",
          pattern: "^[a-z0-9]+$",
          primaryKey: true,
          required: true,
          system: true,
          type: "text"
        },
        {
          name: "user",
          type: "relation",
          required: true,
          maxSelect: 1,
          cascadeDelete: true,
          collectionId: usersCol.id
        },
        {
          name: "fantasy_team_id",
          type: "relation",
          required: true,
          maxSelect: 1,
          cascadeDelete: false,
          collectionId: fantasyTeamsCol.id
        },
        { name: "overrides", type: "json" },
        { name: "created", type: "autodate", onCreate: true },
        { name: "updated", type: "autodate", onCreate: true, onUpdate: true }
      ]
    });
    app.save(teamProfilesCol);
  }

  // 2. auctions: add optional `sim` flag
  const auctionsCol = app.findCollectionByNameOrId("auctions");
  if (!auctionsCol.fields.getByName("sim")) {
    auctionsCol.fields.add(new Field({ name: "sim", type: "bool" }));
    app.save(auctionsCol);
  }
}, (app) => {
  // down: remove auctions.sim, then delete team_profiles
  const auctionsCol = app.findCollectionByNameOrId("auctions");
  if (auctionsCol.fields.getByName("sim")) {
    auctionsCol.fields.removeByName("sim");
    app.save(auctionsCol);
  }

  try {
    const teamProfilesCol = app.findCollectionByNameOrId("team_profiles");
    app.delete(teamProfilesCol);
  } catch (_) {
    // already gone
  }
});
