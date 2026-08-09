/// <reference path="../pb_data/types.d.ts" />
//
// The original draft_picks.timestamp field is an autodate. PocketBase ignores
// caller-provided values for autodates, so historical imports made in 2026 were
// stamped as 2026 even though the importer supplied the correct draft year.
// Add explicit date fields for the actual auction/pick time, then backfill them.
migrate((app) => {
  const auctions = app.findCollectionByNameOrId("auctions");
  if (!auctions.fields.getByName("drafted_at")) {
    auctions.fields.add(new Field({ name: "drafted_at", type: "date" }));
    app.save(auctions);
  }

  const picks = app.findCollectionByNameOrId("draft_picks");
  if (!picks.fields.getByName("drafted_at")) {
    picks.fields.add(new Field({ name: "drafted_at", type: "date" }));
    app.save(picks);
  }

  // Preserve genuine timestamps (including the live 2025 draft). When an
  // official completed draft's auto timestamp has the wrong year, synthesize a
  // stable September 1 time in pick order; the source data only contains a year.
  app.db().newQuery(`
    UPDATE draft_picks
    SET drafted_at = CASE
      WHEN EXISTS (
        SELECT 1 FROM auctions a
        WHERE a.id = draft_picks.auction_id
          AND a.type = 'official'
          AND a.status = 'completed'
          AND CAST(strftime('%Y', draft_picks.timestamp) AS INTEGER) != a.year
      ) THEN (
        SELECT strftime(
          '%Y-%m-%d %H:%M:%fZ',
          printf('%04d-09-01 00:00:00', a.year),
          printf('+%d seconds', draft_picks.pick_order)
        )
        FROM auctions a
        WHERE a.id = draft_picks.auction_id
      )
      ELSE draft_picks.timestamp
    END
    WHERE drafted_at = ''
  `).execute();

  // An auction's effective timestamp is its first pick. Empty drafts fall back
  // to their creation time, which is correct for newly created live drafts.
  app.db().newQuery(`
    UPDATE auctions
    SET drafted_at = COALESCE(
      (SELECT MIN(dp.drafted_at) FROM draft_picks dp WHERE dp.auction_id = auctions.id),
      created
    )
    WHERE drafted_at = ''
  `).execute();
}, (app) => {
  const picks = app.findCollectionByNameOrId("draft_picks");
  if (picks.fields.getByName("drafted_at")) {
    picks.fields.removeByName("drafted_at");
    app.save(picks);
  }

  const auctions = app.findCollectionByNameOrId("auctions");
  if (auctions.fields.getByName("drafted_at")) {
    auctions.fields.removeByName("drafted_at");
    app.save(auctions);
  }
});
