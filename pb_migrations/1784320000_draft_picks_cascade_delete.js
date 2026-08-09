/// <reference path="../pb_data/types.d.ts" />
//
// Cascade draft_picks when their auction is deleted.
//
// Canonical copy lives in the app repo (pb_migrations/); copy this file into the
// PocketBase instance's pb_migrations/ directory and restart `pocketbase serve`
// to apply it.
//
// deleteAuction() used to delete each pick by hand before deleting the auction,
// but draft_picks.deleteRule requires `auction_id.status = "active"` — so a
// completed draft that had any picks could never be deleted (403 on the first
// pick). auction_teams.auction_id already cascades; draft_picks did not. With
// the cascade, PocketBase removes the picks itself when the auction record goes,
// which never evaluates the per-pick rule, so completed drafts stay immutable
// through every other path (AD-10).
migrate((app) => {
  const collection = app.findCollectionByNameOrId("draft_picks");
  collection.fields.getByName("auction_id").cascadeDelete = true;
  app.save(collection);
}, (app) => {
  const collection = app.findCollectionByNameOrId("draft_picks");
  collection.fields.getByName("auction_id").cascadeDelete = false;
  app.save(collection);
});
