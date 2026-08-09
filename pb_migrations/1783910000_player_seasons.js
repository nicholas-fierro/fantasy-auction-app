/// <reference path="../pb_data/types.d.ts" />
//
// Per-season player data.
//
// Canonical copy lives in the app repo (pb_migrations/); a copy must be placed in
// the PocketBase instance's pb_migrations/ directory, where it auto-applies on
// `pocketbase serve`.
//
// Schema:
//   - new `player_seasons` collection: per-(player, year) stats row. `players`
//     keeps stable identity (name, position) so draft_picks/watchlist relations
//     never move; the season-scoped stats live here.
//   - `auctions` gains a `type` select (official|mock). Official auctions are the
//     real league drafts whose prices become trusted historical data; mock
//     auctions are throwaway what-ifs.
//
// Data backfill:
//   - one `player_seasons` row per existing player with year = 2025, copying the
//     frozen season fields off `players`.
//   - auctions named "2025 Draft" become `official`, everything else `mock`.
//
// The season fields on `players` (team, position_rank, bye_week, sos, ecr_vs_adp,
// rank, tier, projected_auction_value, is_rookie) are LEFT IN PLACE but frozen —
// the app no longer reads or writes them (same treatment as
// players.actual_auction_value / fantasy_teams.draft_order from earlier
// migrations). is_rookie moves to seasons because it is season-scoped.
// player_seasons.actual_auction_value stays empty here: 2025 actual prices
// already live on the official draft's draft_picks.price (not double-stored).
//
// API rules match `players` (open — public read/write); the production lockdown
// rules ship separately, same as the auth migration.
migrate((app) => {
  const playersCol = app.findCollectionByNameOrId("players");

  // 1. player_seasons collection
  let seasonsCol;
  try {
    seasonsCol = app.findCollectionByNameOrId("player_seasons");
  } catch (_) {
    seasonsCol = new Collection({
      name: "player_seasons",
      type: "base",
      listRule: "",
      viewRule: "",
      createRule: "",
      updateRule: "",
      deleteRule: "",
      indexes: [
        "CREATE UNIQUE INDEX `idx_player_seasons_player_year` ON `player_seasons` (`player_id`, `year`)",
        "CREATE INDEX `idx_player_seasons_year` ON `player_seasons` (`year`)"
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
          collectionId: playersCol.id
        },
        { name: "year", type: "number", onlyInt: true, required: true },
        { name: "team", type: "text" },
        { name: "position_rank", type: "number", onlyInt: true },
        { name: "bye_week", type: "number", onlyInt: true },
        { name: "sos", type: "number", onlyInt: true },
        { name: "ecr_vs_adp", type: "number", onlyInt: true },
        { name: "rank", type: "number", onlyInt: true },
        { name: "tier", type: "number", onlyInt: true },
        { name: "projected_auction_value", type: "number" },
        { name: "actual_auction_value", type: "number" },
        { name: "is_rookie", type: "bool" },
        { name: "created", type: "autodate", onCreate: true },
        { name: "updated", type: "autodate", onCreate: true, onUpdate: true }
      ]
    });
    app.save(seasonsCol);
    seasonsCol = app.findCollectionByNameOrId("player_seasons");
  }

  // 2. auctions: add type (optional until backfilled)
  let auctionsCol = app.findCollectionByNameOrId("auctions");
  if (!auctionsCol.fields.getByName("type")) {
    auctionsCol.fields.add(new Field({
      name: "type",
      type: "select",
      required: false,
      maxSelect: 1,
      values: ["official", "mock"]
    }));
    app.save(auctionsCol);
  }

  // 3. Backfill: one player_seasons row per player, year 2025
  const players = app.findAllRecords("players");
  for (const player of players) {
    try {
      app.findFirstRecordByFilter(
        "player_seasons",
        `player_id = '${player.id}' && year = 2025`
      );
    } catch (_) {
      const row = new Record(seasonsCol);
      row.set("player_id", player.id);
      row.set("year", 2025);
      row.set("team", player.get("team"));
      row.set("position_rank", player.get("position_rank"));
      row.set("bye_week", player.get("bye_week"));
      row.set("sos", player.get("sos"));
      row.set("ecr_vs_adp", player.get("ecr_vs_adp"));
      row.set("rank", player.get("rank"));
      row.set("tier", player.get("tier"));
      row.set("projected_auction_value", player.get("projected_auction_value"));
      row.set("is_rookie", player.get("is_rookie"));
      // actual_auction_value intentionally left empty
      app.save(row);
    }
  }

  // 4. Backfill auction.type, then tighten to required
  const auctions = app.findAllRecords("auctions");
  for (const auction of auctions) {
    if (auction.getString("type") !== "") continue;
    auction.set("type", auction.getString("name") === "2025 Draft" ? "official" : "mock");
    app.save(auction);
  }

  auctionsCol = app.findCollectionByNameOrId("auctions");
  const typeField = auctionsCol.fields.getByName("type");
  if (typeField && !typeField.required) {
    typeField.required = true;
    app.save(auctionsCol);
  }
}, (app) => {
  // down: drop auctions.type, then the player_seasons collection
  const auctionsCol = app.findCollectionByNameOrId("auctions");
  if (auctionsCol.fields.getByName("type")) {
    auctionsCol.fields.removeByName("type");
    app.save(auctionsCol);
  }

  try {
    const seasonsCol = app.findCollectionByNameOrId("player_seasons");
    app.delete(seasonsCol);
  } catch (_) {
    // already gone
  }
});
