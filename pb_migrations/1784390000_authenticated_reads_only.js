/// <reference path="../pb_data/types.d.ts" />
//
// Close the null-relation read hole across every collection that still has it.
//
// The rules were written on the assumption that comparing a field against
// `@request.auth.id` implies authentication. It does not. A guest carries
// auth.id "", and a relation that is EMPTY resolves to null, which PocketBase
// compares equal to "". So any rule of the form
//
//     league.commissioner = @request.auth.id
//
// is TRUE for an anonymous caller whenever `league` is unset — the clause is
// self-authorizing on exactly the records nobody claimed.
//
// This was live in production. Before 1784380000, an anonymous request could
// read all 8 of this league's historical auctions and all 1,524 of their picks,
// because those rows predate the league model and carry an empty `league`.
// That migration wrapped `auctions` and `draft_picks`. It missed the rest:
// `auction_teams` was still returning 96 rows to anonymous callers, and
// `auction_nomination_events`, `invites`, `league_members`, and `leagues` carry
// the same shape and would leak the moment they hold a row with an empty
// relation. `invites` is the one that matters most — those are signup tokens.
//
// The fix is a single invariant: NO UNAUTHENTICATED READS ANYWHERE. Every
// affected list/view rule is wrapped in `@request.auth.id != "" && (...)`.
// Wrapping is strictly more restrictive — for any authenticated caller the
// guard is true and the rule reduces to exactly what it was — so this cannot
// grant access, only withdraw it from guests. This app has no public read
// surface; every screen is behind login.
//
// Collections whose rules are of the form `user = @request.auth.id` are NOT
// touched and do not need it: their create rules (`@request.auth.id != "" &&
// user = @request.auth.id`) guarantee the relation is non-empty, so there is no
// null to collapse into a guest's "".
//
// Written to be idempotent — it checks for the guard before applying it — so
// re-running it, or running it after the rules were set by hand, is a no-op.
//
// Canonical copy lives in the app repo (pb_migrations/); copy into the
// PocketBase instance's pb_migrations/ and restart. Reflected in
// 1784300000_baseline_full.js per the CI parity check.

const AUTHED = '@request.auth.id != ""';

// Only collections whose read rules reference a relation that may legitimately
// be empty. See the note above for why the `user = ...` collections are exempt.
const COLLECTIONS = [
  "auction_teams",
  "auction_nomination_events",
  "invites",
  "league_members",
  "leagues",
];

migrate((app) => {
  for (const name of COLLECTIONS) {
    const collection = app.findCollectionByNameOrId(name);
    for (const key of ["listRule", "viewRule"]) {
      const rule = collection[key];
      // Null means superuser-only, empty string means public-by-design; neither
      // is the shape this migration is about. Skip anything already guarded.
      if (!rule || rule.indexOf(AUTHED) === 0) continue;
      collection[key] = AUTHED + " && (" + rule + ")";
    }
    app.save(collection);
  }
}, (app) => {
  for (const name of COLLECTIONS) {
    const collection = app.findCollectionByNameOrId(name);
    for (const key of ["listRule", "viewRule"]) {
      const rule = collection[key];
      if (!rule || rule.indexOf(AUTHED + " && (") !== 0) continue;
      collection[key] = rule.substring((AUTHED + " && (").length, rule.length - 1);
    }
    app.save(collection);
  }
});
