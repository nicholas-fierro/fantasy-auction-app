/// <reference path="../pb_data/types.d.ts" />
//
// Phase 4 of the direct-PocketBase-client rewrite: enable the batch API.
//
// The watchlist-reorder and team-reorder writes move client-side and use
// pb.createBatch() so each reorder is a single transactional round trip. The
// batch endpoint (POST /api/batch) is disabled by default, so enable it here.
//
// This is a global instance setting (it also affects the debt-mgmt-app that
// shares this instance), but it only opens the endpoint — per-collection API
// rules still authorize every write inside a batch, so it grants no new access.
//
// Canonical copy lives in the app repo (pb_migrations/); copy into the PB
// instance's pb_migrations/ dir and restart PB. Reversible via down().
migrate((app) => {
  const settings = app.settings();
  settings.batch.enabled = true;
  // Watchlist reorders can touch many rows; raise the per-batch cap generously.
  settings.batch.maxRequests = 200;
  app.save(settings);
}, (app) => {
  const settings = app.settings();
  settings.batch.enabled = false;
  app.save(settings);
});
