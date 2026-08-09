/// <reference path="../pb_data/types.d.ts" />
//
// Enforce one active auction per owner and auction type.
//
// Canonical copy lives in the app repo (pb_migrations/); copy this file into the
// PocketBase instance's pb_migrations/ directory and restart `pocketbase serve`
// to apply it.
//
// The partial index preserves legacy rows without an owner and permits an active
// mock and official auction to coexist for the same user.
//
// PRE-FLIGHT: a duplicate row makes the index build fail, and PocketBase applies
// migrations at startup — so a violation aborts the boot, not just the migration.
// The previous invariant was stricter (one active auction per user, any type), so
// real data should already comply, but confirm before copying this in:
//
//   sqlite3 ~/Pocketbase/main/pb_data/data.db \
//     "SELECT user, type, count(*) c FROM auctions
//      WHERE status='active' AND user!='' GROUP BY user, type HAVING c>1;"
//
// Any rows returned must be completed or deleted first.
migrate((app) => {
  const collection = app.findCollectionByNameOrId("auctions");
  collection.addIndex(
    "idx_auctions_active_user_type",
    true,
    "user, type",
    "status = 'active' AND user != ''"
  );
  app.save(collection);
}, (app) => {
  const collection = app.findCollectionByNameOrId("auctions");
  collection.removeIndex("idx_auctions_active_user_type");
  app.save(collection);
});
