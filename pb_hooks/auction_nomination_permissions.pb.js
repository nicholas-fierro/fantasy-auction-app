/// <reference path="../pb_data/types.d.ts" />
//
// Server-side authorization for shared official-auction nominations (AD-20).
// Collection rules establish league membership and payload shape; this hook
// enforces the stateful constraints that API rules cannot express:
//   - a non-commissioner may nominate only for their team, on that team's turn
//   - they may replace or clear only their own still-active nomination
//   - the commissioner may operate the draft room for any team

onRecordCreateRequest((e) => {
  // PocketBase executes request callbacks in an isolated JSVM context, so all
  // helpers used by the callback must be declared inside it.
  const defaultPaidAuctionSlots = 7;

  function paidAuctionSlots(league) {
    if (!league) return defaultPaidAuctionSlots;
    const settings = league.get("settings");
    const configured = settings && Number(settings.paidAuctionSlots);
    return Number.isInteger(configured) && configured > 0
      ? configured
      : defaultPaidAuctionSlots;
  }

  function latestActiveNomination(app, auctionId) {
    const events = app.findRecordsByFilter(
      "auction_nomination_events",
      "auction_id = {:auctionId}",
      "-event_order",
      1,
      0,
      { auctionId }
    );
    if (events.length === 0 || events[0].getString("action") !== "nominate") {
      return null;
    }

    const picks = app.findRecordsByFilter(
      "draft_picks",
      "auction_id = {:auctionId}",
      "pick_order",
      0,
      0,
      { auctionId }
    );
    return picks.length > events[0].getInt("pick_count") ? null : events[0];
  }

  function assignNominationPosition() {
    const auctionId = e.record.getString("auction_id");
    const picks = e.app.findRecordsByFilter(
      "draft_picks",
      "auction_id = {:auctionId}",
      "pick_order",
      0,
      0,
      { auctionId }
    );
    e.record.set("pick_count", picks.length);

    const providedOrder = e.record.getInt("event_order");
    if (e.hasSuperuserAuth() && providedOrder > 0) return;

    const latest = e.app.findRecordsByFilter(
      "auction_nomination_events",
      "auction_id = {:auctionId}",
      "-event_order",
      1,
      0,
      { auctionId }
    );
    e.record.set(
      "event_order",
      latest.length > 0 ? latest[0].getInt("event_order") + 1 : 1
    );
  }

  // Keep this block aligned with getNominatorForPick in src/lib/draft-turn.ts.
  // src/lib/draft-turn.golden.test.ts extracts and executes it verbatim.
  // drift-guard:start currentNominatorTeamId
  // Same snake rule as snakeSlotIndex in src/lib/snake-draft.ts: nomination
  // rounds alternate direction, so the last team nominates twice in a row.
  function snakeSlotIndex(slot, teamCount) {
    const round = Math.floor(slot / teamCount);
    const position = slot % teamCount;
    return round % 2 === 0 ? position : teamCount - 1 - position;
  }

  function currentNominatorTeamId(app, auctionId, slotLimit) {
    const teams = app.findRecordsByFilter(
      "auction_teams",
      "auction_id = {:auctionId}",
      "draft_order,id",
      0,
      0,
      { auctionId }
    );
    if (teams.length === 0 || slotLimit <= 0) return "";

    const picks = app.findRecordsByFilter(
      "draft_picks",
      "auction_id = {:auctionId}",
      "pick_order,created,id",
      0,
      0,
      { auctionId }
    );
    const pricedPickCounts = {};
    for (const team of teams) {
      pricedPickCounts[team.getString("fantasy_team_id")] = 0;
    }

    let cursor = 0;
    for (let index = 0; index <= picks.length; index++) {
      // The snake sequence has period 2 * teams.length, so only a window that
      // wide always reaches every team from an arbitrary cursor. A shorter one
      // can report "no nominator" while a team with open slots sits past it.
      const maxAttempts = 2 * teams.length;
      let attempts = 0;
      while (
        attempts < maxAttempts &&
        (pricedPickCounts[
          teams[snakeSlotIndex(cursor, teams.length)].getString("fantasy_team_id")
        ] || 0) >= slotLimit
      ) {
        cursor++;
        attempts++;
      }
      if (attempts >= maxAttempts) return "";

      const nominator = teams[snakeSlotIndex(cursor, teams.length)].getString("fantasy_team_id");
      if (index === picks.length) return nominator;

      cursor++;
      const pick = picks[index];
      if (pick.getFloat("price") > 0) {
        const winningTeam = pick.getString("fantasy_team_id");
        pricedPickCounts[winningTeam] = (pricedPickCounts[winningTeam] || 0) + 1;
      }
    }

    return "";
  }
  // drift-guard:end currentNominatorTeamId

  assignNominationPosition();

  if (e.hasSuperuserAuth()) {
    e.next();
    return;
  }

  const authId = e.auth ? e.auth.getString("id") : "";
  if (!authId || e.record.getString("user") !== authId) {
    throw new ForbiddenError("The nomination author must match the signed-in user");
  }

  const auctionId = e.record.getString("auction_id");
  const auction = e.app.findRecordById("auctions", auctionId);
  const leagueId = auction.getString("league");
  const league = leagueId ? e.app.findRecordById("leagues", leagueId) : null;
  const isCommissioner = !!league && league.getString("commissioner") === authId;
  if (isCommissioner) {
    e.next();
    return;
  }

  let membership;
  try {
    membership = e.app.findFirstRecordByFilter(
      "league_members",
      "league = {:leagueId} && user = {:authId}",
      { leagueId, authId }
    );
  } catch (_) {
    throw new ForbiddenError("Only league members may nominate players");
  }

  const activeNomination = latestActiveNomination(e.app, auctionId);
  const activeAuthorId = activeNomination
    ? activeNomination.getString("user")
    : "";
  const action = e.record.getString("action");

  if (action === "clear") {
    if (!activeNomination || activeAuthorId !== authId) {
      throw new ForbiddenError("Only the user who nominated this player may remove them");
    }
    e.next();
    return;
  }

  if (activeNomination && activeAuthorId !== authId) {
    throw new ForbiddenError("Only the current nominator may replace this player");
  }

  const expectedTeamId = currentNominatorTeamId(
    e.app,
    auctionId,
    paidAuctionSlots(league)
  );
  if (
    !expectedTeamId ||
    membership.getString("fantasy_team") !== expectedTeamId
  ) {
    throw new ForbiddenError("It is not your team's nomination turn");
  }

  e.next();
}, "auction_nomination_events");
