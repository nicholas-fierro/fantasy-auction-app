/// <reference path="../pb_data/types.d.ts" />
//
// Multi-auction support.
//
// Canonical copy lives in the app repo (pb_migrations/); a copy must be placed in
// the PocketBase instance's pb_migrations/ directory, where it auto-applies on
// `pocketbase serve`.
//
// Schema:
//   - new `auctions` collection (name, year, status: active|completed)
//   - new `auction_teams` collection (per-auction team draft order)
//   - `draft_picks` gains `auction_id` (relation) and `price` (sale price; null for snake picks)
//
// Data backfill:
//   - creates a "2025 Draft" auction (active) and attaches all existing picks to it
//   - copies each fantasy team's global draft_order into auction_teams
//   - copies players.actual_auction_value (>0) into the pick's price
//
// players.actual_auction_value and fantasy_teams.draft_order are left in place
// but the app no longer reads or writes them.
migrate((app) => {
  const fantasyTeamsCol = app.findCollectionByNameOrId("fantasy_teams");

  // 1. auctions collection
  let auctionsCol;
  try {
    auctionsCol = app.findCollectionByNameOrId("auctions");
  } catch (_) {
    auctionsCol = new Collection({
      name: "auctions",
      type: "base",
      listRule: "",
      viewRule: "",
      createRule: "",
      updateRule: "",
      deleteRule: "",
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
        { name: "name", type: "text", required: true },
        { name: "year", type: "number", onlyInt: true },
        {
          name: "status",
          type: "select",
          required: true,
          maxSelect: 1,
          values: ["active", "completed"]
        },
        { name: "created", type: "autodate", onCreate: true },
        { name: "updated", type: "autodate", onCreate: true, onUpdate: true }
      ]
    });
    app.save(auctionsCol);
    auctionsCol = app.findCollectionByNameOrId("auctions");
  }

  // 2. auction_teams collection (per-auction draft order)
  let auctionTeamsCol;
  try {
    auctionTeamsCol = app.findCollectionByNameOrId("auction_teams");
  } catch (_) {
    auctionTeamsCol = new Collection({
      name: "auction_teams",
      type: "base",
      listRule: "",
      viewRule: "",
      createRule: "",
      updateRule: "",
      deleteRule: "",
      indexes: [
        "CREATE UNIQUE INDEX `idx_auction_teams_auction_team` ON `auction_teams` (`auction_id`, `fantasy_team_id`)"
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
          name: "auction_id",
          type: "relation",
          required: true,
          maxSelect: 1,
          cascadeDelete: true,
          collectionId: auctionsCol.id
        },
        {
          name: "fantasy_team_id",
          type: "relation",
          required: true,
          maxSelect: 1,
          cascadeDelete: false,
          collectionId: fantasyTeamsCol.id
        },
        { name: "draft_order", type: "number", onlyInt: true, required: true },
        { name: "created", type: "autodate", onCreate: true },
        { name: "updated", type: "autodate", onCreate: true, onUpdate: true }
      ]
    });
    app.save(auctionTeamsCol);
    auctionTeamsCol = app.findCollectionByNameOrId("auction_teams");
  }

  // 3. draft_picks: add auction_id + price (auction_id optional until backfilled)
  let draftPicksCol = app.findCollectionByNameOrId("draft_picks");
  let picksChanged = false;
  if (!draftPicksCol.fields.getByName("auction_id")) {
    draftPicksCol.fields.add(new Field({
      name: "auction_id",
      type: "relation",
      required: false,
      maxSelect: 1,
      cascadeDelete: false,
      collectionId: auctionsCol.id
    }));
    picksChanged = true;
  }
  if (!draftPicksCol.fields.getByName("price")) {
    draftPicksCol.fields.add(new Field({ name: "price", type: "number" }));
    picksChanged = true;
  }
  if (picksChanged) {
    app.save(draftPicksCol);
  }

  // 4. Backfill: find-or-create the 2025 Draft auction
  let auction;
  try {
    auction = app.findFirstRecordByFilter("auctions", "name = '2025 Draft'");
  } catch (_) {
    auction = new Record(auctionsCol);
    auction.set("name", "2025 Draft");
    auction.set("year", 2025);
    auction.set("status", "active");
    app.save(auction);
  }

  // snapshot each team's current global draft_order into auction_teams
  const teams = app.findAllRecords("fantasy_teams");
  for (const team of teams) {
    try {
      app.findFirstRecordByFilter(
        "auction_teams",
        `auction_id = '${auction.id}' && fantasy_team_id = '${team.id}'`
      );
    } catch (_) {
      const row = new Record(auctionTeamsCol);
      row.set("auction_id", auction.id);
      row.set("fantasy_team_id", team.id);
      row.set("draft_order", team.getInt("draft_order"));
      app.save(row);
    }
  }

  // attach existing picks to the auction and copy the sale price off the player
  const picks = app.findAllRecords("draft_picks");
  for (const pick of picks) {
    if (pick.getString("auction_id") !== "") continue;
    pick.set("auction_id", auction.id);
    const playerId = pick.getString("player_id");
    if (playerId) {
      try {
        const player = app.findRecordById("players", playerId);
        const value = player.getFloat("actual_auction_value");
        if (value > 0) {
          pick.set("price", value);
        }
      } catch (_) {
        // player record missing; leave price empty
      }
    }
    app.save(pick);
  }

  // 5. now that every pick has an auction, make the relation required
  draftPicksCol = app.findCollectionByNameOrId("draft_picks");
  const auctionField = draftPicksCol.fields.getByName("auction_id");
  if (auctionField && !auctionField.required) {
    auctionField.required = true;
    app.save(draftPicksCol);
  }
}, (app) => {
  // down: remove the added draft_picks fields, then the new collections
  const draftPicksCol = app.findCollectionByNameOrId("draft_picks");
  let picksChanged = false;
  for (const name of ["auction_id", "price"]) {
    const field = draftPicksCol.fields.getByName(name);
    if (field) {
      draftPicksCol.fields.removeByName(name);
      picksChanged = true;
    }
  }
  if (picksChanged) {
    app.save(draftPicksCol);
  }

  for (const name of ["auction_teams", "auctions"]) {
    try {
      const collection = app.findCollectionByNameOrId(name);
      app.delete(collection);
    } catch (_) {
      // already gone
    }
  }
});
