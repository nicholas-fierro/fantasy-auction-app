/// <reference path="../pb_data/types.d.ts" />
//
// Multi-user step 2a: draft-pick uniqueness (docs/multi-user-plan.md).
//
// Canonical copy lives in the app repo (pb_migrations/); a copy must be placed in
// the PocketBase instance's pb_migrations/ directory, where it auto-applies on
// `pocketbase serve`.
//
// Two unique indexes back up the server-assigned pick ordering
// (pb_hooks/draft_picks_pick_order.pb.js):
//   - (auction_id, pick_order) — no duplicate ordering within an auction
//   - (auction_id, player_id)  — a player can only be drafted once per auction
//
// Repair first: the 2025 Draft was entered live through the old client-side
// pick_order assignment (AD-8) and its race actually happened — duplicated and
// gapped pick_orders (e.g. three picks numbered 4). Any auction with duplicates
// is renumbered 1..N ordered by (pick_order, created, id), preserving the
// recorded coarse order and breaking ties by entry time. This edits completed
// auctions (normally immutable per AD-10) as a one-time superuser-level data
// repair; the renumbering is not reversible, but relative order is preserved.

migrate((app) => {
  // 1. Renumber auctions that contain duplicate pick_orders.
  const dupAuctionIds = new Set();
  for (const pick of app.findAllRecords("draft_picks")) {
    dupAuctionIds.add(pick.getString("auction_id"));
  }
  for (const auctionId of dupAuctionIds) {
    const picks = app.findRecordsByFilter(
      "draft_picks",
      "auction_id = {:auctionId}",
      "pick_order,created,id",
      0,
      0,
      { auctionId }
    );
    const seen = new Set();
    let hasDupes = false;
    for (const pick of picks) {
      const order = pick.getInt("pick_order");
      if (seen.has(order)) {
        hasDupes = true;
        break;
      }
      seen.add(order);
    }
    if (!hasDupes) continue;

    let next = 1;
    for (const pick of picks) {
      if (pick.getInt("pick_order") !== next) {
        pick.set("pick_order", next);
        app.save(pick);
      }
      next++;
    }
  }

  // 2. Unique indexes.
  const col = app.findCollectionByNameOrId("draft_picks");
  col.addIndex("idx_draft_picks_auction_pick_order", true, "auction_id, pick_order", "");
  col.addIndex("idx_draft_picks_auction_player", true, "auction_id, player_id", "");
  app.save(col);
}, (app) => {
  // down: drop the indexes (the renumbering repair is intentionally one-way).
  const col = app.findCollectionByNameOrId("draft_picks");
  col.removeIndex("idx_draft_picks_auction_pick_order");
  col.removeIndex("idx_draft_picks_auction_player");
  app.save(col);
});
