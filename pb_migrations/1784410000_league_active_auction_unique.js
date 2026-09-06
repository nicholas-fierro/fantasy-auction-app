/// <reference path="../pb_data/types.d.ts" />

migrate((app) => {
  const collection = app.findCollectionByNameOrId("auctions");
  collection.removeIndex("idx_auctions_active_user_type");
  collection.addIndex(
    "idx_auctions_active_league_user_type",
    true,
    "league, user, type",
    "status = 'active' AND user != ''"
  );
  app.save(collection);
}, (app) => {
  const collection = app.findCollectionByNameOrId("auctions");
  collection.removeIndex("idx_auctions_active_league_user_type");
  // Restoring the stricter invariant must fail rather than end active drafts.
  collection.addIndex(
    "idx_auctions_active_user_type",
    true,
    "user, type",
    "status = 'active' AND user != ''"
  );
  app.save(collection);
});
