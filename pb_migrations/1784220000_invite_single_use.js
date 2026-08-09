/// <reference path="../pb_data/types.d.ts" />
//
// Phase 1 security hardening (issue #33): atomic single-use invites.
//
// Canonical copy lives in the app repo (pb_migrations/); a copy must be placed in
// the PocketBase instance's pb_migrations/ directory, where it auto-applies on
// `pocketbase serve`.
//
// signupWithInvite (src/server/actions/signup.ts) creates the league_members row
// stamped with the invite id. A partial UNIQUE index on that column lets the
// database — not app code — enforce that one invite yields at most one
// membership: two users racing the same token both pass the read-time checks,
// but only one membership INSERT commits; the loser's INSERT is rejected
// atomically and the action rolls its just-created user back. The index is
// partial (WHERE invite != '') so the backfilled pre-existing memberships (which
// carry no invite) don't collide with each other.
//
// This composes with the constraints already present: for the approved
// email-pinned invites the `users` unique-email index already blocks the second
// signup; the (league, fantasy_team) unique index blocks a second claim of a
// pinned team. This index closes the remaining hole — a team-less, email-less
// invite redeemed twice concurrently.

migrate((app) => {
  const col = app.findCollectionByNameOrId("league_members");

  if (!col.fields.getByName("invite")) {
    // Optional relation to the consumed invite; no cascade so deleting an invite
    // never removes an established membership.
    col.fields.add(new Field({
      name: "invite",
      type: "relation",
      required: false,
      maxSelect: 1,
      cascadeDelete: false,
      collectionId: app.findCollectionByNameOrId("invites").id
    }));
    app.save(col);
  }

  col.addIndex("idx_league_members_invite", true, "invite", "invite != ''");
  app.save(col);
}, (app) => {
  const col = app.findCollectionByNameOrId("league_members");
  col.removeIndex("idx_league_members_invite");
  app.save(col);
  if (col.fields.getByName("invite")) {
    col.fields.removeByName("invite");
    app.save(col);
  }
});
