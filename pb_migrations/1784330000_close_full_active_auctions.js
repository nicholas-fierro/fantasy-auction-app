/// <reference path="../pb_data/types.d.ts" />
//
// Backfill active auctions that already contain every roster pick. The runtime
// hook in pb_hooks/draft_picks_auto_complete.pb.js handles future picks.

migrate((app) => {
  function rosterSize(auction) {
    // Mirrors DEFAULT_ROSTER_SETTINGS in src/lib/roster.ts: 9 starters + 6 bench.
    const defaultRosterSize = 15;
    const leagueId = auction.getString("league");
    if (!leagueId) return defaultRosterSize;

    let league;
    try {
      league = app.findRecordById("leagues", leagueId);
    } catch (_) {
      return defaultRosterSize;
    }

    let settings;
    try {
      settings = JSON.parse(league.get("settings").string());
    } catch (_) {
      return defaultRosterSize;
    }
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
      return defaultRosterSize;
    }

    const starterCount =
      Array.isArray(settings.starterPositions) &&
      settings.starterPositions.length > 0 &&
      settings.starterPositions.every((position) => typeof position === "string")
        ? settings.starterPositions.length
        : 9;
    const benchSize =
      Number.isInteger(settings.benchSize) && settings.benchSize >= 0
        ? settings.benchSize
        : 6;
    const size = starterCount + benchSize;

    return size > 0 ? size : defaultRosterSize;
  }

  const auctions = app.findRecordsByFilter(
    "auctions",
    "status = 'active'",
    "id",
    0,
    0
  );
  for (const auction of auctions) {
    const teams = app.findRecordsByFilter(
      "auction_teams",
      "auction_id = {:auctionId}",
      "id",
      0,
      0,
      { auctionId: auction.id }
    );
    if (teams.length === 0) continue;

    const picks = app.findRecordsByFilter(
      "draft_picks",
      "auction_id = {:auctionId}",
      "id",
      0,
      0,
      { auctionId: auction.id }
    );
    if (picks.length >= teams.length * rosterSize(auction)) {
      auction.set("status", "completed");
      app.save(auction);
    }
  }
}, () => {
  // Data migrations are intentionally irreversible: reopening an auction could
  // make a completed draft mutable after the backfill has run.
});
