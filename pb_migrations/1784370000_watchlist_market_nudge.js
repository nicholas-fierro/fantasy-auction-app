/// <reference path="../pb_data/types.d.ts" />
//
// A per-player market nudge for the mock draft: "whatever the value model says,
// this room likes him more than that." 1 (or empty) means no opinion.
//
// It lives on `watchlist` rather than in a new collection because watchlist is
// already unique on (player_id, user) and already carries per-user API rules —
// exactly the scope a manager's private read on a player needs. `player_seasons`
// would be wrong: that is shared league data, and this is one person's opinion.
//
// Deliberately not fitted. Nothing in eight drafts predicts a specific player's
// hype (`ecr_vs_adp` correlates 0.036 with price-over-model on the one season that
// has both), so the knowledge enters as an explicit input instead of a fake
// feature. The engine clamps it to 0.4-2.5 in src/lib/mock-draft/pricing.ts.

migrate((app) => {
  const watchlist = app.findCollectionByNameOrId("watchlist");
  if (!watchlist.fields.getByName("market_nudge")) {
    watchlist.fields.add(new Field({
      name: "market_nudge",
      type: "number",
      required: false,
      onlyInt: false,
      min: 0.4,
      max: 2.5
    }));
  }
  app.save(watchlist);
}, (app) => {
  const watchlist = app.findCollectionByNameOrId("watchlist");
  if (watchlist.fields.getByName("market_nudge")) watchlist.fields.removeByName("market_nudge");
  app.save(watchlist);
});
