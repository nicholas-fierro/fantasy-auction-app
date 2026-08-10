/// <reference path="../pb_data/types.d.ts" />
//
// Outside-league auction boards as shared comp data.
//
// scripts/import-external-auction.ts loads another league's completed auction
// so the value model has same-year market evidence. Until now those auctions
// were hidden by accident rather than on purpose: they carry no `user` and no
// `league`, which matches none of the three clauses in the auctions list rule,
// so only superuser callers could read them.
//
// That accidental hiding is a bug once the data is meant to be used. The CLI
// (superuser) would price a year off the external board while the in-app
// "Recalculate Projected Prices" button (the caller's own auth) silently
// priced it off one fewer year — two paths, two answers, no error, breaking
// the invariant that both produce identical numbers by construction (AD-15).
//
// So: mark these auctions with an explicit `external` flag rather than
// inferring intent from two empty relations, and grant every authenticated
// user read access to them and their picks. This is deliberately a READ grant
// on both `list` and `view` — `getFullList` (used by loadFromPocketBase and
// history-client) is governed by the LIST rule, so a view-only grant would not
// have fixed the button.
//
// Writes stay superuser-only: no clause is added to create/update/delete, and
// an external auction has no owner or commissioner to satisfy the existing
// ones. The app keeps these out of the UI in the client (auction-context
// filters `external`), not via the API rule — the model needs to read them,
// and the auction picker must not offer them.
//
// Canonical copy lives in the app repo (pb_migrations/); copy into the
// PocketBase instance's pb_migrations/ and restart (schema is cached in
// memory). Reflected in 1784300000_baseline_full.js per the CI parity check.

const EXTERNAL_READ = ' || (type = "official" && external = true)';
const EXTERNAL_READ_PICKS = ' || (auction_id.type = "official" && auction_id.external = true)';

migrate((app) => {
  const auctions = app.findCollectionByNameOrId("auctions");
  if (!auctions.fields.getByName("external")) {
    auctions.fields.add(new Field({
      name: "external",
      type: "bool",
      required: false
    }));
  }
  // Appended, never rewritten: the existing three clauses are the league's own
  // access model and this migration has no opinion about them.
  if (auctions.listRule.indexOf("external = true") === -1) {
    auctions.listRule = auctions.listRule + EXTERNAL_READ;
    auctions.viewRule = auctions.viewRule + EXTERNAL_READ;
  }
  app.save(auctions);

  const picks = app.findCollectionByNameOrId("draft_picks");
  if (picks.listRule.indexOf("external = true") === -1) {
    picks.listRule = picks.listRule + EXTERNAL_READ_PICKS;
    picks.viewRule = picks.viewRule + EXTERNAL_READ_PICKS;
  }
  app.save(picks);
}, (app) => {
  const picks = app.findCollectionByNameOrId("draft_picks");
  picks.listRule = picks.listRule.replace(EXTERNAL_READ_PICKS, "");
  picks.viewRule = picks.viewRule.replace(EXTERNAL_READ_PICKS, "");
  app.save(picks);

  const auctions = app.findCollectionByNameOrId("auctions");
  auctions.listRule = auctions.listRule.replace(EXTERNAL_READ, "");
  auctions.viewRule = auctions.viewRule.replace(EXTERNAL_READ, "");
  if (auctions.fields.getByName("external")) auctions.fields.removeByName("external");
  app.save(auctions);
});
