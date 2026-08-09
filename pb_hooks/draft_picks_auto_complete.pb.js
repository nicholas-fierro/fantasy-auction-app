/// <reference path="../pb_data/types.d.ts" />
//
// Complete an auction after its final roster pick. This runs after the pick has
// been saved so all authorised writers, including non-owner league members,
// trigger the same server-side lifecycle transition.
//
// Canonical copy lives in the app repo (pb_hooks/); a copy must be placed in
// the PocketBase instance's pb_hooks/ directory where it loads on
// `pocketbase serve` startup.

onRecordAfterCreateSuccess((e) => {
  // PocketBase executes request callbacks in an isolated JSVM context, so all
  // helpers used by the callback must be declared inside it.
  function rosterSize(auction) {
    // Mirrors DEFAULT_ROSTER_SETTINGS in src/lib/roster.ts: 9 starters + 6 bench.
    const defaultRosterSize = 15;
    const leagueId = auction.getString("league");
    if (!leagueId) return defaultRosterSize;

    let league;
    try {
      league = e.app.findRecordById("leagues", leagueId);
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

  const auctionId = e.record.getString("auction_id");
  let auction;
  try {
    auction = e.app.findRecordById("auctions", auctionId);
  } catch (_) {
    e.next();
    return;
  }

  if (auction.getString("status") !== "active") {
    e.next();
    return;
  }

  const teams = e.app.countRecords(
    "auction_teams",
    $dbx.hashExp({ auction_id: auctionId })
  );
  if (teams === 0) {
    e.next();
    return;
  }

  const picks = e.app.countRecords(
    "draft_picks",
    $dbx.hashExp({ auction_id: auctionId })
  );
  if (picks >= teams * rosterSize(auction)) {
    auction.set("status", "completed");
    try {
      e.app.save(auction);
    } catch (error) {
      console.error("Failed to complete auction after final pick", auctionId, error);
    }
  }

  e.next();
}, "draft_picks");
