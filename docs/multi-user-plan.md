# Multi-User Plan: Accounts, Leagues, and Team-Bound Picks

Design + build order for turning the single-operator draft helper into a
multi-user app where an admin (league commissioner) runs the draft and league
members tied to a team can enter their own picks. Designed for one league today,
scalable to many.

Companion decision log: `ARCHITECTURE_DECISIONS.md` (this plan retires the debt
flagged in AD-9's consequences and executes the multi-writer path AD-8 deferred).

## Goals

1. **Account creation** — invite-based signup; no public REST signup.
2. **User ↔ team binding** — a user is a member of a league and owns one of its
   fantasy teams; "my team" derives from that membership, not a constant.
3. **Hybrid draft entry** — the admin can enter picks for any team (covers
   members not using the app); a logged-in member can enter picks for their own
   team when they're up.
4. **Multi-league shape** — league settings and team groupings are rows, not
   constants, even though only one league exists today.

Explicit non-goal (v1): **in-app live bidding**. Bidding stays in the room; the
app records results. Nothing here blocks adding bidding later.

## Data model

### New collections

**`leagues`**
- `name` (text, required)
- `commissioner` (relation → users, required, single) — the admin. A direct
  field, not a role on the membership row, because PB multi-relation rule
  conditions aren't row-correlated (`role ?= "commissioner" && user ?= X` could
  match two different rows), so rules like `league.commissioner =
  @request.auth.id` need the direct relation to be safe. Co-commissioners are a
  later problem.
- `settings` (json) — what `DEFAULT_ROSTER_SETTINGS` hardcodes today: budget,
  paidAuctionSlots, minimumBid, starterPositions, benchSize.

**`league_members`**
- `league` (relation → leagues, required, cascade delete)
- `user` (relation → users, required, cascade delete)
- `fantasy_team` (relation → fantasy_teams, optional — a member may not have
  claimed a team yet)
- Unique indexes: `(league, user)` and `(league, fantasy_team)` — one team per
  user per league, one user per team. SQLite unique indexes permit multiple
  NULL `fantasy_team` rows, so unclaimed members coexist fine.

**`invites`**
- `league` (relation, required, cascade delete), `token` (text, unique),
  `email` (optional), `fantasy_team` (optional pre-assignment),
  `used_by` (relation → users, optional), `expires` (date, optional)
- Managed by the commissioner in the Admin view; consumed server-side during
  signup (no public read rule needed — the signup server action reads it with
  the service credential).

### Relations added to existing collections

- `fantasy_teams.league` (optional relation)
- `auctions.league` (optional relation)

`players` / `player_seasons` stay global shared reference data.

### Backfill (same migration)

- Create the one real league (`commissioner` = the user owning the official
  auctions), settings = current `DEFAULT_ROSTER_SETTINGS` values.
- Point all `fantasy_teams` and all `auctions` at it.
- Insert the `league_members` row binding the owner to team `p6k1jto8cd8cs3v`
  (the retiring `USER_TEAM_ID` constant — hardcoded one last time, here).
- Skipped entirely on a fresh instance (no official auctions → no backfill).

## Account creation

`users.createRule` stays `null` (AD-2 closed public signup deliberately). The
flow is a Next.js server action — consistent with AD-6's "lifecycle stays
server-side":

1. Commissioner creates an invite in Admin (optionally pre-assigning a team),
   shares the `/signup?token=…` link.
2. `signupWithInvite(token, email, password, name)` validates the invite,
   creates the user, creates the `league_members` row, marks the invite used.
3. Client then runs the existing login path (`authWithPassword` → `syncSession`)
   unchanged.

This requires a **standing service credential** in `.env` for the server action
(deviation from AD-13's ephemeral-superuser stance — gets its own AD). Email
verification / password reset need PB SMTP config; optional, not a local
blocker.

## Pick writes: two-lane authorization + serialized ordering

### Authorization (PB API rules, per AD-2)

`draft_picks` create (still gated on `auction_id.status = "active"`):

| Who | Can write picks for |
|---|---|
| Commissioner of the auction's league | any team |
| Member bound to a team | their own team only |
| Other members | read-only (live via existing SSE) |

Sketch: `auction_id.status = "active" && (auction_id.league.commissioner =
@request.auth.id || fantasy_team_id.league_members_via_fantasy_team.user ?=
@request.auth.id)`. Update/delete (undo): commissioner only (AD-10 intent).

Also in this rules pass:
- `auctions` / `auction_teams` / `draft_picks` **read** widens from owner-only
  to owner-or-league-member for official auctions; mocks stay private.
- `fantasy_teams` writes tighten from any-authed to commissioner-only (closes
  the reference-data hole; imports run under the commissioner's token so the
  pipeline keeps working).
- Every rules change is verified with a second account (AD-2 discipline).

### Ordering (supersedes AD-8)

Client-assigned `pick_order` races with two writers. Fix:

- **`pb_hooks/` hook** on `draft_picks` create assigns `pick_order = max + 1`
  inside PocketBase; clients stop sending it. `pb_hooks/` becomes a second
  deployment artifact with the same copy-and-restart workflow as
  `pb_migrations/`.
- **Unique indexes** as backstop: `(auction_id, pick_order)` and
  `(auction_id, player_id)` — residual races fail cleanly and retry instead of
  corrupting.
- Optimistic updates + idempotent SSE upserts already tolerate server-assigned
  order arriving on confirmation.

### "On the clock" semantics

- **Snake:** exact turn from pick count + draft order
  (`calculateCurrentSnakeTeam`). Member UI enables drafting only on their turn;
  the PocketBase hook hard-enforces the turn for non-commissioner writers.
- **Auction:** "up" = nominating, but the recorded pick belongs to the
  *winning* team, usually not the nominator. So: on their nomination turn a
  member sets the active player; any member may record a win **for their own
  team**; the admin records everything else. A PocketBase hook enforces the
  nomination rotation and prevents members from replacing or clearing another
  user's active nomination; the own-team-only rule governs the eventual win.

## App-side changes

- `USER_TEAM_ID` → `useUserTeam()` (selected auction → league → my
  `league_members` row → team). `isUserTeam()` takes the resolved id.
  Consumers: mock-draft context, draft-day dashboard, team-roster,
  active-player-panel, team-budget-pressure, roster-summary,
  watchlist-sidebar.
- League settings load from `leagues.settings`, falling back to
  `DEFAULT_ROSTER_SETTINGS`; roster/budget functions already take a settings
  param.
- Pick entry becomes role-aware (admin: any team; member: own team, gated as
  above) with an on-the-clock indicator for members.

## Build order

1. **Schema migration** — leagues, league_members, invites, relations,
   backfill. App keeps working unchanged after this.
2. **Concurrency foundation** — unique indexes + pb_hook for pick_order.
3. **API rules migration** — two-lane pick rule, league-member reads,
   fantasy_teams tightening; second-account isolation verification.
4. **Membership-derived user team + DB league settings** — retires AD-9 debt;
   app still single-user-equivalent.
5. **Signup** — server action, `/signup` page, invite management in Admin.
6. **Role-aware pick entry UI** + league-wide official-auction reads.
7. **Decision log** — new ADs: league model, service credential, AD-8
   supersession.
