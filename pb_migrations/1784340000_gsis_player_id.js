/// <reference path="../pb_data/types.d.ts" />
//
// Stable NFL player identifier used to join players to nflverse records.

migrate((app) => {
  const players = app.findCollectionByNameOrId("players");
  if (!players.fields.getByName("gsis_id")) {
    players.fields.add(new Field({
      name: "gsis_id",
      type: "text",
      required: false
    }));
  }
  if (!players.indexes.some((index) => index.includes("idx_players_gsis_id"))) {
    players.addIndex("idx_players_gsis_id", true, "gsis_id", "gsis_id != ''");
  }
  app.save(players);
}, (app) => {
  const players = app.findCollectionByNameOrId("players");
  players.removeIndex("idx_players_gsis_id");
  if (players.fields.getByName("gsis_id")) players.fields.removeByName("gsis_id");
  app.save(players);
});
