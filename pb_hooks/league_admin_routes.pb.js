/// <reference path="../pb_data/types.d.ts" />
//
// Scoped league-admin routes (issue #54): the privileged operations that used
// to run through a standing PocketBase superuser credential in the Next.js app
// (invite signup, invite preview, commissioner member list, commissioner
// password reset) now live here as custom PB routes. The app calls them with a
// plain/unauthenticated client (public routes) or the caller's own token
// (commissioner routes) — no superuser secret in the Next.js runtime.
//
// Canonical copy lives in the app repo (pb_hooks/); a copy must be placed in
// the PocketBase instance's pb_hooks/ directory (sibling of pb_migrations/),
// where it loads on `pocketbase serve` startup — same copy-and-restart
// workflow as migrations and the other hooks.
//
// Error bodies carry a machine-readable `code` so the Next callers can map them
// back to the existing user-facing strings. Every invite-path failure collapses
// to `invite_invalid` (or `invite_claimed`) — no enumeration oracle; the
// specific reason is server-log-only.

// ---- POST /api/league-admin/signup (public) ----
routerAdd("POST", "/api/league-admin/signup", (e) => {
  const body = e.requestInfo().body || {};
  const token = String(body.token || "");
  const email = String(body.email || "").trim().toLowerCase();
  const password = String(body.password || "");
  const name = String(body.name || "").trim();

  if (!token || !email || !password || password.length < 8) {
    return e.json(400, { code: "invalid_input" });
  }

  // Mirror src/server/lib/invite.ts validateInvite exactly (fails closed).
  function inviteReason(invite, checkEmail) {
    if (invite.getString("used_by")) return "already consumed";
    const expires = invite.getString("expires");
    if (!expires || expires.trim() === "") return "missing expiry (fail closed)";
    const exp = new Date(expires);
    if (isNaN(exp.getTime())) return "unparseable expiry (fail closed)";
    if (exp < new Date()) return "expired";
    if (checkEmail) {
      const pinned = invite.getString("email");
      if (pinned && pinned.toLowerCase() !== email) return "email mismatch";
    }
    return null;
  }

  try {
    e.app.runInTransaction((txApp) => {
      let invite;
      try {
        invite = txApp.findFirstRecordByFilter("invites", "token = {:token}", { token });
      } catch (err) {
        throw new Error("code:invite_invalid");
      }

      const reason = inviteReason(invite, true);
      if (reason) {
        console.log("Signup invite rejected (" + reason + ")");
        throw new Error("code:invite_invalid");
      }

      // Create the (verified) user. verified=true so login works without SMTP —
      // the invite token is the verification.
      const user = new Record(txApp.findCollectionByNameOrId("users"));
      user.set("email", email);
      user.set("name", name);
      user.set("verified", true);
      if (typeof user.setPassword === "function") {
        user.setPassword(password);
      } else {
        user.set("password", password);
      }
      try {
        txApp.save(user);
      } catch (err) {
        const msg = String(err && err.message ? err.message : "").toLowerCase();
        if (msg.indexOf("email") !== -1) throw new Error("code:email_exists");
        console.log("Signup user creation failed: " + msg);
        throw new Error("code:error");
      }

      // Bind to the invite's league/team. The partial UNIQUE index on
      // league_members.invite is the atomic single-use gate: a racing second
      // signup with the same token loses here and, being inside the transaction,
      // rolls the just-created user back too (no orphan — better than the old
      // best-effort delete).
      const member = new Record(txApp.findCollectionByNameOrId("league_members"));
      member.set("league", invite.getString("league"));
      member.set("user", user.id);
      member.set("fantasy_team", invite.getString("fantasy_team") || "");
      member.set("invite", invite.id);
      try {
        txApp.save(member);
      } catch (err) {
        console.log("Signup membership creation failed (likely claimed): " + (err && err.message));
        throw new Error("code:invite_claimed");
      }

      invite.set("used_by", user.id);
      txApp.save(invite);
    });
  } catch (err) {
    const m = String(err && err.message ? err.message : "");
    if (m.indexOf("code:email_exists") !== -1) return e.json(400, { code: "email_exists" });
    if (m.indexOf("code:invite_claimed") !== -1) return e.json(409, { code: "invite_claimed" });
    if (m.indexOf("code:invite_invalid") !== -1) return e.json(400, { code: "invite_invalid" });
    console.log("Signup failed: " + m);
    return e.json(400, { code: "error" });
  }

  return e.json(200, { ok: true });
});

// ---- POST /api/league-admin/invite-preview (public) ----
routerAdd("POST", "/api/league-admin/invite-preview", (e) => {
  const body = e.requestInfo().body || {};
  const token = String(body.token || "");
  if (!token) return e.json(400, { code: "invite_invalid" });

  let invite;
  try {
    invite = e.app.findFirstRecordByFilter("invites", "token = {:token}", { token });
  } catch (err) {
    console.log("Invite preview rejected (not found)");
    return e.json(400, { code: "invite_invalid" });
  }

  // Preview omits the email check (address unknown) but still fails closed on
  // used_by + expiry.
  if (invite.getString("used_by")) {
    return e.json(400, { code: "invite_invalid" });
  }
  const expires = invite.getString("expires");
  if (!expires || expires.trim() === "" || isNaN(new Date(expires).getTime()) || new Date(expires) < new Date()) {
    return e.json(400, { code: "invite_invalid" });
  }

  let leagueName = "";
  const leagueId = invite.getString("league");
  if (leagueId) {
    try { leagueName = e.app.findRecordById("leagues", leagueId).getString("name"); } catch (err) {}
  }
  let teamName = "";
  const teamId = invite.getString("fantasy_team");
  if (teamId) {
    try { teamName = e.app.findRecordById("fantasy_teams", teamId).getString("name"); } catch (err) {}
  }

  return e.json(200, {
    ok: true,
    leagueName: leagueName,
    teamName: teamName,
    emailLocked: !!invite.getString("email"),
  });
});

// ---- GET /api/league-admin/members?league=<id> (commissioner only) ----
routerAdd("GET", "/api/league-admin/members", (e) => {
  if (!e.auth) return e.json(401, { code: "unauthorized" });

  const leagueId = String(e.requestInfo().query.league || "");
  if (!leagueId) return e.json(400, { code: "invalid_input" });

  let league;
  try {
    league = e.app.findRecordById("leagues", leagueId);
  } catch (err) {
    return e.json(404, { code: "not_found" });
  }
  if (league.getString("commissioner") !== e.auth.getString("id")) {
    return e.json(403, { code: "forbidden" });
  }

  const records = e.app.findRecordsByFilter(
    "league_members",
    "league = {:league}",
    "created",
    0,
    0,
    { league: leagueId }
  );

  const members = [];
  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    let userName = "";
    let userEmail = "";
    const userId = rec.getString("user");
    if (userId) {
      try {
        const u = e.app.findRecordById("users", userId);
        userName = u.getString("name");
        userEmail = u.getString("email");
      } catch (err) {}
    }
    let teamName = "";
    const teamId = rec.getString("fantasy_team");
    if (teamId) {
      try { teamName = e.app.findRecordById("fantasy_teams", teamId).getString("name"); } catch (err) {}
    }
    members.push({
      id: rec.id,
      league: rec.getString("league"),
      user: userId,
      userName: userName,
      userEmail: userEmail,
      fantasy_team: teamId,
      teamName: teamName,
    });
  }

  return e.json(200, { members: members });
});

// ---- POST /api/league-admin/reset-password (commissioner only) ----
routerAdd("POST", "/api/league-admin/reset-password", (e) => {
  if (!e.auth) return e.json(401, { code: "unauthorized" });

  const body = e.requestInfo().body || {};
  const memberId = String(body.memberId || "");
  if (!memberId) return e.json(400, { code: "invalid_input" });

  let member;
  try {
    member = e.app.findRecordById("league_members", memberId);
  } catch (err) {
    return e.json(404, { code: "not_found" });
  }

  let league;
  try {
    league = e.app.findRecordById("leagues", member.getString("league"));
  } catch (err) {
    return e.json(404, { code: "not_found" });
  }
  if (league.getString("commissioner") !== e.auth.getString("id")) {
    return e.json(403, { code: "forbidden" });
  }

  const targetUserId = member.getString("user");
  if (!targetUserId) return e.json(400, { code: "no_account" });

  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  let password;
  if (typeof $security !== "undefined" && $security.randomStringWithAlphabet) {
    password = $security.randomStringWithAlphabet(14, alphabet);
  } else {
    // Fallback — $security is always present in PocketBase, so this shouldn't run.
    password = "";
    for (let i = 0; i < 14; i++) password += alphabet[Math.floor(Math.random() * alphabet.length)];
  }

  try {
    const user = e.app.findRecordById("users", targetUserId);
    if (typeof user.setPassword === "function") {
      user.setPassword(password);
    } else {
      user.set("password", password);
    }
    e.app.save(user);
  } catch (err) {
    console.log("Password reset failed: " + (err && err.message));
    return e.json(500, { code: "error" });
  }

  return e.json(200, { ok: true, password: password });
});
