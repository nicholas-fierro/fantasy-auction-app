/// <reference path="../pb_data/types.d.ts" />
//
// Player headshot image IDs.
//
// Canonical copy lives in the app repo (pb_migrations/); a copy must be placed in
// the PocketBase instance's pb_migrations/ directory, where it auto-applies on
// `pocketbase serve`.
//
// Schema:
//   - `players` gains two optional text fields, `sleeper_id` and `espn_id` —
//     external player IDs used to build headshot CDN URLs client-side:
//       - sleeper_id -> https://sleepercdn.com/content/nfl/players/{id}.jpg
//       - espn_id    -> ESPN's combiner headshot CDN
//     Both are populated by `scripts/sync-player-images.ts`, which matches
//     app players against Sleeper's public player dump. Left empty for
//     players that don't match (e.g. very old historical players).
//
// No indexes, no API-rule changes.
migrate((app) => {
  const playersCol = app.findCollectionByNameOrId("players");
  let changed = false;

  if (!playersCol.fields.getByName("sleeper_id")) {
    playersCol.fields.add(new Field({
      name: "sleeper_id",
      type: "text",
      required: false
    }));
    changed = true;
  }

  if (!playersCol.fields.getByName("espn_id")) {
    playersCol.fields.add(new Field({
      name: "espn_id",
      type: "text",
      required: false
    }));
    changed = true;
  }

  if (changed) app.save(playersCol);
}, (app) => {
  const playersCol = app.findCollectionByNameOrId("players");
  let changed = false;

  if (playersCol.fields.getByName("sleeper_id")) {
    playersCol.fields.removeByName("sleeper_id");
    changed = true;
  }

  if (playersCol.fields.getByName("espn_id")) {
    playersCol.fields.removeByName("espn_id");
    changed = true;
  }

  if (changed) app.save(playersCol);
});
