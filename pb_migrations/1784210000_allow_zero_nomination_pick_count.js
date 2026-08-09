/// <reference path="../pb_data/types.d.ts" />
// PocketBase's required-number validator treats zero as blank. Zero is the
// correct nomination pick-count snapshot before the first sale; the create
// hook always assigns this field, so schema-level `required` is unnecessary.

migrate((app) => {
  const collection = app.findCollectionByNameOrId("auction_nomination_events");
  collection.fields.getByName("pick_count").required = false;
  app.save(collection);
}, (app) => {
  const collection = app.findCollectionByNameOrId("auction_nomination_events");
  collection.fields.getByName("pick_count").required = true;
  app.save(collection);
});
