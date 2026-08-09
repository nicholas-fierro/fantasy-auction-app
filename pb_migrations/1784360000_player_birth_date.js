/// <reference path="../pb_data/types.d.ts" />
//
// Birth date (ISO YYYY-MM-DD) from nflverse rosters, so age is available as a
// draft feature. Text rather than date: the source is a plain date with no time
// or zone, and storing it as a timestamp would invent both.

migrate((app) => {
  const players = app.findCollectionByNameOrId("players");
  if (!players.fields.getByName("birth_date")) {
    players.fields.add(new Field({
      name: "birth_date",
      type: "text",
      required: false
    }));
  }
  app.save(players);
}, (app) => {
  const players = app.findCollectionByNameOrId("players");
  if (players.fields.getByName("birth_date")) players.fields.removeByName("birth_date");
  app.save(players);
});
