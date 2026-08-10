/// <reference path="../pb_data/types.d.ts" />
//
// Outside-league auction boards as shared comp data.
//
// scripts/import-external-auction.ts loads another league's completed auction
// so the value model has same-year market evidence. Until now those auctions
// were hidden by accident rather than on purpose: they carry no `user` and no
// `league`, which matched none of the three clauses in the auctions list rule,
// so only superuser callers could read them.
//
// That accidental hiding is a bug once the data is meant to be used. The CLI
// (superuser) would price a year off the external board while the in-app
// "Recalculate Projected Prices" button (the caller's own auth) silently priced
// it off one fewer year — two paths, two answers, no error, breaking the
// invariant that both produce identical numbers by construction (AD-15).
//
// So: mark these auctions with an explicit `external` flag rather than
// inferring intent from two empty relations, and grant AUTHENTICATED users read
// access to them and their picks. This is deliberately a read grant on both
// `list` and `view` — `getFullList` (used by loadFromPocketBase and
// history-client) is governed by the LIST rule, so a view-only grant would not
// have fixed the button.
//
// Two guards make that grant safe:
//
//   1. `external` is superuser-only to WRITE. It is an ordinary client-writable
//      bool otherwise, so without this a commissioner could set it on their own
//      league's auction and publish that auction and every one of its picks.
//      Create and update now require `@request.body.external != true`;
//      superusers bypass API rules entirely, so the importer is unaffected.
//
//   2. Every read clause is now wrapped in `@request.auth.id != ""`. The rules
//      previously had no explicit auth requirement, relying on each clause
//      comparing against `@request.auth.id` — but a GUEST has auth.id "", and an
//      auction with an empty `league` makes `league.commissioner` resolve to
//      null, which PocketBase compares equal to "". Any league-less auction was
//      therefore world-readable, which predates this migration but would apply
//      to external boards too (they are league-less by construction). Wrapping
//      is strictly more restrictive: it cannot grant access that the existing
//      clauses did not already grant.
//
// Writes are otherwise untouched: an external auction has no owner or
// commissioner to satisfy the existing create/update/delete rules. The app
// keeps these out of the UI in the client (auction-context filters `external`),
// not via the API rule — the model needs to read them, and the auction picker
// must not offer them.
//
// Canonical copy lives in the app repo (pb_migrations/); copy into the
// PocketBase instance's pb_migrations/ and restart (schema is cached in
// memory). Reflected in 1784300000_baseline_full.js per the CI parity check.

const AUTHED = '@request.auth.id != ""';
const NOT_EXTERNAL = '@request.body.external != true';

const AUCTION_READ_BASE =
  'user = @request.auth.id || league.commissioner = @request.auth.id || (type = "official" && league.league_members_via_league.user ?= @request.auth.id)';
const AUCTION_READ =
  AUTHED + ' && (' + AUCTION_READ_BASE + ' || (type = "official" && external = true))';

const PICKS_READ_BASE =
  'auction_id.user = @request.auth.id || auction_id.league.commissioner = @request.auth.id || (auction_id.type = "official" && auction_id.league.league_members_via_league.user ?= @request.auth.id)';
const PICKS_READ =
  AUTHED + ' && (' + PICKS_READ_BASE + ' || (auction_id.type = "official" && auction_id.external = true))';

migrate((app) => {
  const auctions = app.findCollectionByNameOrId("auctions");
  if (!auctions.fields.getByName("external")) {
    auctions.fields.add(new Field({
      name: "external",
      type: "bool",
      required: false
    }));
  }
  auctions.listRule = AUCTION_READ;
  auctions.viewRule = AUCTION_READ;
  // Only a superuser may mark an auction external; superusers bypass rules.
  auctions.createRule = auctions.createRule + " && " + NOT_EXTERNAL;
  auctions.updateRule = "(" + auctions.updateRule + ") && " + NOT_EXTERNAL;
  app.save(auctions);

  const picks = app.findCollectionByNameOrId("draft_picks");
  picks.listRule = PICKS_READ;
  picks.viewRule = PICKS_READ;
  app.save(picks);
}, (app) => {
  const picks = app.findCollectionByNameOrId("draft_picks");
  picks.listRule = PICKS_READ_BASE;
  picks.viewRule = PICKS_READ_BASE;
  app.save(picks);

  const auctions = app.findCollectionByNameOrId("auctions");
  auctions.listRule = AUCTION_READ_BASE;
  auctions.viewRule = AUCTION_READ_BASE;
  auctions.createRule = auctions.createRule.replace(" && " + NOT_EXTERNAL, "");
  auctions.updateRule = auctions.updateRule
    .replace(" && " + NOT_EXTERNAL, "")
    .replace(/^\((.*)\)$/, "$1");
  if (auctions.fields.getByName("external")) auctions.fields.removeByName("external");
  app.save(auctions);
});
