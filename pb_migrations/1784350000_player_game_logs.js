/// <reference path="../pb_data/types.d.ts" />
//
// Imported nflverse player game logs. Authenticated users may read them;
// only a PocketBase superuser may run the importer that writes them.

migrate((app) => {
  try {
    app.findCollectionByNameOrId("player_game_logs");
    return;
  } catch (_) {
    // create below
  }

  const players = app.findCollectionByNameOrId("players");
  const collection = new Collection({
    name: "player_game_logs",
    type: "base",
    listRule: '@request.auth.id != ""',
    viewRule: '@request.auth.id != ""',
    createRule: null,
    updateRule: null,
    deleteRule: null,
    indexes: [
      "CREATE UNIQUE INDEX `idx_player_game_logs_player_game` ON `player_game_logs` (`player_id`, `game_id`)",
      "CREATE INDEX `idx_player_game_logs_player_season_week` ON `player_game_logs` (`player_id`, `season`, `season_type`, `week`)"
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
        name: "player_id",
        type: "relation",
        required: true,
        maxSelect: 1,
        cascadeDelete: true,
        collectionId: players.id
      },
      { name: "season", type: "number", required: true, onlyInt: true },
      { name: "week", type: "number", required: true, onlyInt: true },
      {
        name: "season_type",
        type: "select",
        required: true,
        maxSelect: 1,
        values: ["REG", "POST"]
      },
      { name: "game_id", type: "text", required: true },
      { name: "team", type: "text", required: true },
      { name: "opponent", type: "text", required: true },
      { name: "stats", type: "json", required: true },
      { name: "created", type: "autodate", onCreate: true },
      { name: "updated", type: "autodate", onCreate: true, onUpdate: true }
    ]
  });

  app.save(collection);
}, (app) => {
  try {
    app.delete(app.findCollectionByNameOrId("player_game_logs"));
  } catch (_) {
    // already gone
  }
});
