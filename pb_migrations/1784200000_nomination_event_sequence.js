/// <reference path="../pb_data/types.d.ts" />
//
// Make nomination ordering and sale resolution causal rather than timestamp-
// based. PocketBase autodates have millisecond precision, so rapid consecutive
// events can share a timestamp and their random record ids do not encode write
// order. `event_order` is server-assigned per auction; `pick_count` snapshots
// how many picks existed when the event was accepted.

migrate((app) => {
  let collection = app.findCollectionByNameOrId("auction_nomination_events");
  let changed = false;

  if (!collection.fields.getByName("event_order")) {
    collection.fields.add(new Field({
      name: "event_order",
      type: "number",
      required: false,
      onlyInt: true,
      min: 1
    }));
    changed = true;
  }
  if (!collection.fields.getByName("pick_count")) {
    collection.fields.add(new Field({
      name: "pick_count",
      type: "number",
      required: false,
      onlyInt: true,
      min: 0
    }));
    changed = true;
  }
  if (changed) app.save(collection);

  app.db().newQuery(`
    UPDATE auction_nomination_events
    SET event_order = (
      SELECT COUNT(*)
      FROM auction_nomination_events earlier
      WHERE earlier.auction_id = auction_nomination_events.auction_id
        AND (
          earlier.created < auction_nomination_events.created
          OR (
            earlier.created = auction_nomination_events.created
            AND earlier.id <= auction_nomination_events.id
          )
        )
    )
    WHERE event_order = 0
  `).execute();

  app.db().newQuery(`
    UPDATE auction_nomination_events
    SET pick_count = (
      SELECT COUNT(*)
      FROM draft_picks
      WHERE draft_picks.auction_id = auction_nomination_events.auction_id
        AND draft_picks.created <= auction_nomination_events.created
    )
    WHERE pick_count = 0
  `).execute();

  collection = app.findCollectionByNameOrId("auction_nomination_events");
  collection.fields.getByName("event_order").required = true;
  // Zero is a valid snapshot before the first pick; PocketBase's number
  // `required` validator treats zero as blank. The create hook always sets it.
  collection.fields.getByName("pick_count").required = false;
  collection.removeIndex("idx_auction_nomination_events_order");
  collection.addIndex(
    "idx_auction_nomination_events_order",
    true,
    "auction_id, event_order",
    ""
  );
  app.save(collection);
}, (app) => {
  const collection = app.findCollectionByNameOrId("auction_nomination_events");
  collection.removeIndex("idx_auction_nomination_events_order");
  collection.fields.removeByName("event_order");
  collection.fields.removeByName("pick_count");
  app.save(collection);
});
