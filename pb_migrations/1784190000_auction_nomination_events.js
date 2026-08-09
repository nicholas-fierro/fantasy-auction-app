/// <reference path="../pb_data/types.d.ts" />
//
// Shared live-auction nominations (AD-20).
//
// A nomination is transient UI state, but it must cross browser/user boundaries.
// Store it as an immutable event stream rather than a mutable field on auctions:
// the highest `event_order` whose `pick_count` still matches the auction is the
// current nomination. A `clear` event dismisses it, and creating a draft_pick
// implicitly resolves it. This also avoids granting league members broad update
// access to the auction record.

migrate((app) => {
  try {
    app.findCollectionByNameOrId("auction_nomination_events");
    return;
  } catch (_) {
    // create below
  }

  const auctionsCol = app.findCollectionByNameOrId("auctions");
  const playersCol = app.findCollectionByNameOrId("players");
  const usersCol = app.findCollectionByNameOrId("users");

  const auctionRead =
    'auction_id.user = @request.auth.id' +
    ' || auction_id.league.commissioner = @request.auth.id' +
    ' || (auction_id.type = "official" && auction_id.league.league_members_via_league.user ?= @request.auth.id)';

  const collection = new Collection({
    name: "auction_nomination_events",
    type: "base",
    listRule: auctionRead,
    viewRule: auctionRead,
    // Official-auction members may submit events; the canonical PocketBase hook
    // enforces nomination turn and active-author constraints that collection
    // rules cannot express. Mocks remain private/local and never write here.
    createRule:
      '@request.auth.id != ""' +
      ' && user = @request.auth.id' +
      ' && auction_id.status = "active"' +
      ' && auction_id.type = "official"' +
      ' && (' + auctionRead + ')' +
      ' && ((action = "nominate" && player_id != "") || (action = "clear" && player_id = ""))',
    // Events are append-only. Corrections are another nominate/clear event.
    updateRule: null,
    deleteRule: null,
    indexes: [
      "CREATE INDEX `idx_auction_nomination_events_latest` ON `auction_nomination_events` (`auction_id`, `created`)",
      "CREATE UNIQUE INDEX `idx_auction_nomination_events_order` ON `auction_nomination_events` (`auction_id`, `event_order`)"
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
        name: "player_id",
        type: "relation",
        required: false,
        maxSelect: 1,
        cascadeDelete: false,
        collectionId: playersCol.id
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
        name: "action",
        type: "select",
        required: true,
        maxSelect: 1,
        values: ["nominate", "clear"]
      },
      {
        name: "event_order",
        type: "number",
        required: true,
        onlyInt: true,
        min: 1
      },
      {
        name: "pick_count",
        type: "number",
        // Zero is a valid snapshot before the first pick; PocketBase's number
        // `required` validator treats zero as blank, so the hook owns this field.
        required: false,
        onlyInt: true,
        min: 0
      },
      { name: "created", type: "autodate", onCreate: true },
      { name: "updated", type: "autodate", onCreate: true, onUpdate: true }
    ]
  });

  app.save(collection);
}, (app) => {
  try {
    app.delete(app.findCollectionByNameOrId("auction_nomination_events"));
  } catch (_) {
    // already gone
  }
});
