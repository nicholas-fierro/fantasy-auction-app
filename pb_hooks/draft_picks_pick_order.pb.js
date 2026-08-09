/// <reference path="../pb_data/types.d.ts" />
//
// Multi-user draft write authority: server-assigned pick ordering plus
// non-commissioner snake-turn enforcement (AD-18/AD-19).
//
// Canonical copy lives in the app repo (pb_hooks/); a copy must be placed in
// the PocketBase instance's pb_hooks/ directory (sibling of pb_migrations/),
// where it loads on `pocketbase serve` startup — same copy-and-restart
// workflow as migrations.
//
// With an admin and team-bound members both writing picks, client-computed
// pick_order races. This hook assigns pick_order = max + 1 for the auction
// inside the create request, so clients stop sending it. Two unique indexes
// ((auction_id, pick_order), (auction_id, player_id) — migration
// 1784170000_draft_pick_unique_indexes.js) backstop the residual read-then-
// write race between concurrent requests: the loser fails cleanly with a 400
// and the client retries (useCreateDraftPick).
//
// Unpriced picks are the snake phase. A non-commissioner can create one only
// for the team currently on the clock. Priced auction wins remain own-team
// authorized by the collection rule because the winner is usually not the
// nominator. Superuser-provided pick_order values are respected so historical
// imports can preserve explicit orders from their source snapshots.

onRecordCreateRequest((e) => {
  // PocketBase executes request callbacks in an isolated JSVM context, so all
  // helpers used by the callback must be declared inside it.
  function getPaidAuctionSlots(leagueId) {
    const defaultPaidAuctionSlots = 7;
    if (!leagueId) return defaultPaidAuctionSlots;
    const league = e.app.findRecordById("leagues", leagueId);
    const settings = league.get("settings");
    const configured = settings && Number(settings.paidAuctionSlots);
    return Number.isInteger(configured) && configured > 0
      ? configured
      : defaultPaidAuctionSlots;
  }

  // Keep this block aligned with calculateCurrentSnakeTeam and snakeSlotIndex
  // in src/lib/snake-draft.ts. src/lib/draft-turn.golden.test.ts extracts and
  // executes it verbatim.
  // drift-guard:start calculateCurrentSnakeTeamId
  function snakeSlotIndex(slot, teamCount) {
    const round = Math.floor(slot / teamCount);
    const position = slot % teamCount;
    return round % 2 === 0 ? position : teamCount - 1 - position;
  }

  function calculateCurrentSnakeTeamId(app, auctionId, paidAuctionSlots) {
    const teams = app.findRecordsByFilter(
      "auction_teams",
      "auction_id = {:auctionId}",
      "draft_order,id",
      0,
      0,
      { auctionId }
    );
    if (teams.length === 0 || paidAuctionSlots <= 0) return "";

    const picks = app.findRecordsByFilter(
      "draft_picks",
      "auction_id = {:auctionId}",
      "pick_order,created,id",
      0,
      0,
      { auctionId }
    );
    if (picks.length < paidAuctionSlots * teams.length) return "";

    // The snake phase restarts the rotation at the first team in draft order,
    // so the slot counter is 0-based within the snake phase rather than
    // continuous with the auction nomination rotation.
    const snakeSlot = picks.length - paidAuctionSlots * teams.length;
    return teams[snakeSlotIndex(snakeSlot, teams.length)]
      .getString("fantasy_team_id");
  }
  // drift-guard:end calculateCurrentSnakeTeamId

  function assertSnakeTurn() {
    if (e.hasSuperuserAuth() || e.record.getFloat("price") > 0) return;

    const authId = e.auth ? e.auth.getString("id") : "";
    if (!authId) return; // the collection rule returns the authentication error

    const auctionId = e.record.getString("auction_id");
    const auction = e.app.findRecordById("auctions", auctionId);
    const leagueId = auction.getString("league");
    if (leagueId) {
      const league = e.app.findRecordById("leagues", leagueId);
      if (league.getString("commissioner") === authId) return;
    }

    const expectedTeamId = calculateCurrentSnakeTeamId(
      e.app,
      auctionId,
      getPaidAuctionSlots(leagueId)
    );
    if (!expectedTeamId) {
      const teams = e.app.findRecordsByFilter(
        "auction_teams",
        "auction_id = {:auctionId}",
        "draft_order,id",
        0,
        0,
        { auctionId }
      );
      if (teams.length === 0) {
        throw new ForbiddenError("This auction has no draft order");
      }
      throw new ForbiddenError("Snake picks cannot be made during the auction phase");
    }

    if (e.record.getString("fantasy_team_id") !== expectedTeamId) {
      throw new ForbiddenError("It is not this team's snake draft turn");
    }
  }

  assertSnakeTurn();
  const provided = e.record.getInt("pick_order");
  if (!(e.hasSuperuserAuth() && provided > 0)) {
    const auctionId = e.record.getString("auction_id");
    let next = 1;
    const last = e.app.findRecordsByFilter(
      "draft_picks",
      "auction_id = {:auctionId}",
      "-pick_order",
      1,
      0,
      { auctionId }
    );
    if (last.length > 0) {
      next = last[0].getInt("pick_order") + 1;
    }
    e.record.set("pick_order", next);
  }
  e.next();
}, "draft_picks");
