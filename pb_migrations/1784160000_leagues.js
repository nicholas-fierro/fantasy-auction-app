/// <reference path="../pb_data/types.d.ts" />
//
// Multi-user step 1: leagues, memberships, and invites (docs/multi-user-plan.md).
//
// Canonical copy lives in the app repo (pb_migrations/); a copy must be placed in
// the PocketBase instance's pb_migrations/ directory, where it auto-applies on
// `pocketbase serve`.
//
// Schema:
//   - new `leagues` collection — name, commissioner (users relation), settings
//     json (the values DEFAULT_ROSTER_SETTINGS hardcodes today). Commissioner is
//     a direct relation rather than a role on league_members because PB
//     multi-relation rule conditions aren't row-correlated, so
//     `league.commissioner = @request.auth.id` is the only safe admin check.
//   - new `league_members` collection — (league, user, fantasy_team) binding;
//     unique on (league, user) and (league, fantasy_team). fantasy_team is
//     optional so a member can exist before claiming a team.
//   - new `invites` collection — commissioner-managed signup tokens, consumed
//     server-side by the signup action (no public read rule needed).
//   - `fantasy_teams` and `auctions` gain an optional `league` relation.
//
// Backfill (skipped on a fresh instance): creates the one real league with the
// official auctions' owner as commissioner, points every fantasy_team and
// auction at it, and binds the owner to their team — the roster.ts USER_TEAM_ID
// constant ('p6k1jto8cd8cs3v'), hardcoded one last time here before the app
// derives it from this membership row.
//
// Existing collection rules are untouched; the two-lane draft-pick rules ship in
// the step 3 migration.

const OWNER_TEAM_ID = "p6k1jto8cd8cs3v";

migrate((app) => {
  const usersCol = app.findCollectionByNameOrId("users");
  const fantasyTeamsCol = app.findCollectionByNameOrId("fantasy_teams");
  const auctionsCol = app.findCollectionByNameOrId("auctions");

  const idField = {
    autogeneratePattern: "[a-z0-9]{15}",
    max: 15,
    min: 15,
    name: "id",
    pattern: "^[a-z0-9]+$",
    primaryKey: true,
    required: true,
    system: true,
    type: "text"
  };

  // 1. leagues — created with closed rules; the member-visibility rules
  // reference league_members via back-relation, so they're set in step 3 below
  // once that collection exists.
  let leaguesCol;
  try {
    leaguesCol = app.findCollectionByNameOrId("leagues");
  } catch (_) {
    leaguesCol = new Collection({
      name: "leagues",
      type: "base",
      listRule: null,
      viewRule: null,
      createRule: null,
      updateRule: null,
      deleteRule: null,
      fields: [
        idField,
        { name: "name", type: "text", required: true },
        {
          name: "commissioner",
          type: "relation",
          required: true,
          maxSelect: 1,
          cascadeDelete: false,
          collectionId: usersCol.id
        },
        { name: "settings", type: "json" },
        { name: "created", type: "autodate", onCreate: true },
        { name: "updated", type: "autodate", onCreate: true, onUpdate: true }
      ]
    });
    app.save(leaguesCol);
  }

  // 2. league_members
  let membersCol;
  try {
    membersCol = app.findCollectionByNameOrId("league_members");
  } catch (_) {
    membersCol = new Collection({
      name: "league_members",
      type: "base",
      // Only the commissioner manages rows; member-wide visibility rules are
      // set right after creation (they back-reference this collection, which
      // must exist before the rule can validate). Signup creates rows
      // server-side with the service credential, which bypasses rules.
      listRule: "league.commissioner = @request.auth.id",
      viewRule: "league.commissioner = @request.auth.id",
      createRule: '@request.auth.id != "" && league.commissioner = @request.auth.id',
      updateRule: "league.commissioner = @request.auth.id",
      deleteRule: "league.commissioner = @request.auth.id",
      indexes: [
        "CREATE UNIQUE INDEX `idx_league_members_league_user` ON `league_members` (`league`, `user`)",
        "CREATE UNIQUE INDEX `idx_league_members_league_team` ON `league_members` (`league`, `fantasy_team`)"
      ],
      fields: [
        idField,
        {
          name: "league",
          type: "relation",
          required: true,
          maxSelect: 1,
          cascadeDelete: true,
          collectionId: leaguesCol.id
        },
        {
          name: "user",
          type: "relation",
          required: true,
          maxSelect: 1,
          cascadeDelete: true,
          collectionId: usersCol.id
        },
        {
          name: "fantasy_team",
          type: "relation",
          required: false,
          maxSelect: 1,
          cascadeDelete: false,
          collectionId: fantasyTeamsCol.id
        },
        { name: "created", type: "autodate", onCreate: true },
        { name: "updated", type: "autodate", onCreate: true, onUpdate: true }
      ]
    });
    app.save(membersCol);
  }

  // 3. Visibility rules that need league_members to exist before they can
  // validate: members can read their league row and its full membership
  // (who owns which team).
  const memberVisible = "league.commissioner = @request.auth.id || league.league_members_via_league.user ?= @request.auth.id";
  membersCol = app.findCollectionByNameOrId("league_members");
  membersCol.listRule = memberVisible;
  membersCol.viewRule = memberVisible;
  app.save(membersCol);

  leaguesCol = app.findCollectionByNameOrId("leagues");
  leaguesCol.listRule = "commissioner = @request.auth.id || league_members_via_league.user ?= @request.auth.id";
  leaguesCol.viewRule = "commissioner = @request.auth.id || league_members_via_league.user ?= @request.auth.id";
  leaguesCol.updateRule = "commissioner = @request.auth.id";
  // create/delete stay superuser-only for now (leagues are born via backfill or
  // future admin tooling).
  app.save(leaguesCol);

  // 4. invites
  try {
    app.findCollectionByNameOrId("invites");
  } catch (_) {
    const invitesCol = new Collection({
      name: "invites",
      type: "base",
      listRule: "league.commissioner = @request.auth.id",
      viewRule: "league.commissioner = @request.auth.id",
      createRule: '@request.auth.id != "" && league.commissioner = @request.auth.id',
      updateRule: "league.commissioner = @request.auth.id",
      deleteRule: "league.commissioner = @request.auth.id",
      indexes: [
        "CREATE UNIQUE INDEX `idx_invites_token` ON `invites` (`token`)"
      ],
      fields: [
        idField,
        {
          name: "league",
          type: "relation",
          required: true,
          maxSelect: 1,
          cascadeDelete: true,
          collectionId: leaguesCol.id
        },
        { name: "token", type: "text", required: true },
        { name: "email", type: "email" },
        {
          name: "fantasy_team",
          type: "relation",
          required: false,
          maxSelect: 1,
          cascadeDelete: false,
          collectionId: fantasyTeamsCol.id
        },
        {
          name: "used_by",
          type: "relation",
          required: false,
          maxSelect: 1,
          cascadeDelete: false,
          collectionId: usersCol.id
        },
        { name: "expires", type: "date" },
        { name: "created", type: "autodate", onCreate: true },
        { name: "updated", type: "autodate", onCreate: true, onUpdate: true }
      ]
    });
    app.save(invitesCol);
  }

  // 5. league relation on fantasy_teams and auctions (optional so existing and
  // pre-backfill rows keep validating)
  if (!fantasyTeamsCol.fields.getByName("league")) {
    fantasyTeamsCol.fields.add(new Field({
      name: "league",
      type: "relation",
      required: false,
      maxSelect: 1,
      cascadeDelete: false,
      collectionId: leaguesCol.id
    }));
    app.save(fantasyTeamsCol);
  }
  if (!auctionsCol.fields.getByName("league")) {
    auctionsCol.fields.add(new Field({
      name: "league",
      type: "relation",
      required: false,
      maxSelect: 1,
      cascadeDelete: false,
      collectionId: leaguesCol.id
    }));
    app.save(auctionsCol);
  }

  // 6. Backfill. The commissioner is derived from the official auctions' owner;
  // a fresh instance has none, so the backfill is skipped entirely.
  let ownerAuction;
  try {
    ownerAuction = app.findFirstRecordByFilter("auctions", "type = 'official' && user != ''");
  } catch (_) {
    return;
  }
  const ownerId = ownerAuction.getString("user");

  let league;
  try {
    league = app.findFirstRecordByFilter("leagues", "commissioner = {:owner}", { owner: ownerId });
  } catch (_) {
    league = new Record(leaguesCol);
    league.set("name", "My League");
    league.set("commissioner", ownerId);
    // Mirrors src/lib/roster.ts DEFAULT_ROSTER_SETTINGS at migration time.
    league.set("settings", {
      budget: 200,
      paidAuctionSlots: 7,
      minimumBid: 1,
      starterPositions: ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "K", "DST"],
      benchSize: 6
    });
    app.save(league);
  }

  for (const team of app.findAllRecords("fantasy_teams")) {
    if (team.getString("league") === "") {
      team.set("league", league.id);
      app.save(team);
    }
  }
  for (const auction of app.findAllRecords("auctions")) {
    if (auction.getString("league") === "") {
      auction.set("league", league.id);
      app.save(auction);
    }
  }

  try {
    app.findFirstRecordByFilter("league_members", "league = {:league} && user = {:user}", {
      league: league.id,
      user: ownerId
    });
  } catch (_) {
    const member = new Record(membersCol);
    member.set("league", league.id);
    member.set("user", ownerId);
    try {
      // The owner's team — guard in case the id doesn't exist on this instance.
      app.findRecordById("fantasy_teams", OWNER_TEAM_ID);
      member.set("fantasy_team", OWNER_TEAM_ID);
    } catch (_) {
      // membership without a claimed team is valid
    }
    app.save(member);
  }
}, (app) => {
  // down: strip the league relations, then delete the collections in reverse
  // dependency order.
  for (const name of ["auctions", "fantasy_teams"]) {
    const col = app.findCollectionByNameOrId(name);
    if (col.fields.getByName("league")) {
      col.fields.removeByName("league");
      app.save(col);
    }
  }
  for (const name of ["invites", "league_members", "leagues"]) {
    try {
      app.delete(app.findCollectionByNameOrId(name));
    } catch (_) {
      // already gone
    }
  }
});
