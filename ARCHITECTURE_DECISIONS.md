# Architectural Decisions

Decision log for the July 2026 performance rework, wave two — the migration from
server-action-proxied data access to direct browser → PocketBase. AD-13 onward
covers the July 2026 historical-data and value-model work (companion:
`docs/auction-value-model.md`).

## AD-1: Browser talks to PocketBase directly; Next.js server actions are no longer the data layer

**Decision.** All reads and routine writes (players, seasons, auctions list, draft
picks, watchlist, teams) go through the PocketBase JS SDK in the browser
(`src/lib/pb-client.ts` singleton). The read/write server actions and their guards
were deleted.

**Why.** Next.js executes server actions sequentially per client, so the app's ~6
initial reads queued behind each other, each adding a proxy hop and its own internal
PB waterfall. PocketBase is a client-facing BaaS; proxying it through Next added
latency and an entire authorization layer we had to hand-write, for no benefit.

**Consequences.** Reads run in parallel; the pb-mappers logic must stay client-safe
(no `next/headers`). Any future deploy requires PB to be publicly reachable over TLS.

## AD-2: Authorization lives in PocketBase collection API rules

**Decision.** Per-user access is enforced by PB API rules (migration
`pb_migrations/1784100000_api_rules_lockdown.js`, reversible): ownership via `user` /
`auction_id.user` relations, and draft-pick writes additionally gated on
`auction_id.status = "active"`. The previously open `users` create rule is closed.

**Deviation from the original plan:** `players`, `player_seasons`, and
`fantasy_teams` writes use `@request.auth.id != ""` (any authenticated user) rather
than superuser-only — the CSV import pipeline authenticates with the *user's* token
and no superuser account exists, so a `null` rule would have broken imports.

**Why.** Rules replace `assertAuctionOwned`/`assertAuctionActive` declaratively and
are the precondition for exposing PB to the browser at all.

**Consequences.** Cross-user isolation was verified with a throwaway account (0
foreign rows visible; foreign writes rejected). Rules are now the security boundary —
test with a second account whenever they change.

## AD-3: Dual auth store — browser authStore plus an httpOnly cookie mirror

**Decision.** Login authenticates client-side (`authWithPassword`, token in
localStorage via the SDK's authStore), then a slim `syncSession` server action mirrors
the token into the existing httpOnly `pb_auth` cookie.

**Why.** The Next.js middleware (login redirects) and the surviving server actions
(imports, auction lifecycle) read that cookie. Setting it via a server action rather
than `document.cookie` keeps it httpOnly and guarantees byte-identical encoding with
what the server parses.

**Consequences.** Logout and 401 handling must clear both stores (done in the session
provider and sidebar logout). The token exists in two places; they are reconciled by
`authRefresh` on app mount.

## AD-4: Realtime SSE subscriptions patch the TanStack Query cache

**Decision.** `src/components/providers/realtime-sync.tsx` subscribes (through the
singleton client only) to `draft_picks` filtered by the selected auction and to
`watchlist`, applying idempotent id-keyed upserts/removals with
`queryClient.setQueryData`. Invalidate-and-refetch is gone from the hot paths.

**Why.** During a live draft, picks should appear instantly without refetch storms;
PB multiplexes all topics over one EventSource per tab.

**Consequences.** The optimistic mutation layers from wave one were **kept** — they
still cover perceived latency, and the realtime upserts being idempotent makes the
two safe together. Simplifying the optimistic layers is an intentional follow-up.

## AD-5: TanStack Query stays; query keys and data shapes are frozen

**Decision.** Only `queryFn`s changed. Every queryKey and returned TypeScript shape
is identical to the server-action era; record mapping lives in `src/lib/pb-mappers.ts`
and `src/lib/history-client.ts`. A shared `['player-seasons', year]` query feeds both
pick and watchlist hydration instead of each refetching the year's season table.

**Why.** Zero component churn during the migration, and each hook was independently
swappable/revertable.

## AD-6: The import pipeline and auction lifecycle stay server-side

**Decision.** CSV imports (`src/server/actions/imports.ts`, `import-core.ts`) and
auction create/complete/delete remain server actions; `assertAuctionOwned` survives
for them.

**Why.** Imports are a batch, fuzzy-matching workload with no interactivity need. The
per-owner, per-type "at most one active draft" invariant cannot be expressed in PB
API rules, so its enforcement point stays on the server. Official and mock drafts
may be active at the same time; replacing one requires an explicit complete/delete
action.

## AD-7: Transactional reorders via the PB batch API (enabled instance-wide)

**Decision.** Watchlist and team reorders use `pb.createBatch()` — one transactional
round trip instead of N updates. The batch endpoint was disabled by default and is
enabled by migration `pb_migrations/1784110000_enable_batch_api.js`.

**Why.** Drag-reorder previously issued one HTTP request per row.

**Consequences.** Batch enablement is a global PB instance setting also visible to
the co-hosted debt-mgmt-app (endpoint only — collection rules still authorize every
sub-request). Reversible via the migration's `down()`.

## AD-8: Draft-pick ordering is assigned client-side

**Decision.** `pick_order` is computed in the browser (`getList(1,1)` on
`sort: '-pick_order'`) at pick creation.

**Why.** Single-operator drafting sessions — there is no write contention to protect
against, and it removes a server round trip from the most latency-sensitive action in
the app.

**Consequences.** If the app ever becomes multi-writer per auction, ordering needs to
move back behind a serialized authority (server action or PB hook).

## AD-9: Roster and auction-budget rules have one shared implementation

**Decision.** `src/lib/roster.ts` owns roster construction, the user-team id, and
the league's auction settings: $200 budget, seven paid auction slots, and a $1
minimum reserved bid per unfilled paid slot. The maximum bid is remaining budget
minus those reserved minimum bids.

**Why.** Team cards, the watchlist, nomination UI, and dashboard previously risked
drifting because each calculated roster or budget state independently.

**Consequences.** The user-team id is still a league-specific constant. Supporting
multiple leagues or user-selected teams requires moving it into persisted league or
auction configuration rather than adding another component-local constant.

## AD-10: Undo removes only the most recent pick in an active auction

**Decision.** The auction switcher exposes a confirmation-gated undo action. The
candidate is selected by timestamp, then creation time, then `pick_order` as the
deterministic fallback. Completed auctions remain immutable.

**Why.** Draft-day entry mistakes need a fast recovery path, but arbitrary deletion
would make accidental historical edits easier.

**Consequences.** Undo is intentionally one level deep. Repeated undo operations are
possible, but every removal requires a fresh confirmation.

## AD-11: Draft insights are derived from existing client data

**Decision.** Tier-cliff alerts, pick recency, draft pace, team budget pressure, and
starter needs are computed from the existing player, draft-pick, team, and watchlist
queries. No new PocketBase collections or fields were added.

**Why.** The required inputs already arrive for the primary draft views. Derived
selectors keep the feature reversible and avoid adding persistence for transient
draft-room signals.

**Consequences.** Pace is based on recorded timestamps and tier warnings depend on
the quality of imported tier data. Both should be treated as decision support, not
authoritative draft constraints.

## AD-12: Draft Day is the default signed-in view

**Superseded by PR #100.** The unused dashboard was removed; the players view is now
the default signed-in landing surface.

**Decision.** The dashboard is a dynamically loaded top-level view and the initial
`NavigationContext` destination. Existing player, roster, and draft-board views stay
available in the top navbar (AD-22; the left icon rail is gone).

**Why.** During a live draft, nomination, budget, roster, target, pace, tier, and
room-pressure context is more useful as a landing surface than a single data table.

**Consequences.** Navigation remains client-state based rather than URL routed. The
dashboard reuses existing hooks and the existing player action flow, so it does not
introduce a second pick-write path.

## AD-13: Pre-app league history lives as official auctions, not imported season values

**Decision.** The 2018–2024 drafts from the league's draft workbook are stored as
first-class `auctions` records (`type: official`, `status: completed`) with real
`draft_picks` prices and `auction_teams`, created by a private one-time importer
from a normalized CSV snapshot (one row per pick). The league's own draft data
and importer are private and are not published in this
repository. The alternative — loading prices into
`player_seasons.actual_auction_value` (the `'imported'` history source) — was not
used; that field stays empty.

**Why.** Official picks are the schema's preferred historical-value source
(`history-client.ts` ignores imported values for years with an official auction),
and full auctions preserve who paid what in which order, enabling per-franchise
analysis that value-only imports cannot support.

**Consequences.** The import is idempotent per year (any year with an official
auction is skipped — this also protects the real 2025 draft) and best-effort
deletes partial records on failure. Drafted players missing a season row get a
minimal `player_seasons` row so the history join doesn't drop their picks; all of
2018's rows are minimal (rank 0), so 2018 prices surface in player history but are
not estimate comps until 2018 rankings are imported. $0 snake picks were originally
only present for the years whose sheets recorded them (2018, 2021); every year
2018–2025 now has its full snake rounds recovered, and AD-27 mines them. Player
matching reuses
`matchPlayer`/`loadPlayerIndex` from `import-core.ts` (now exported). Admin scripts
authenticate with an ephemeral superuser (created via `pocketbase superuser
upsert`, deleted after each run) — no standing superuser exists, consistent with
AD-2.

## AD-14: Franchises are persistent identities; workbook labels are resolved at import

**Decision.** Historical picks attribute to the league's 12 persistent
`fantasy_teams`, not to labels used in old sheets. An owner-reviewed, year-aware
mapping resolves renamed teams during import. Private source snapshots keep their
raw labels; translation happens only at import.

**Why.** Team names change year to year, but analysis (manager tendencies, AD-15's
model inputs) needs continuous franchise histories. Keeping source data faithful
to the original separates "what the workbook says" from "what we know it means."

**Consequences.** All 12 franchises have complete 8-season pick histories.
Temporary records created for old labels were merged into their successors and
deleted. Future label changes need one mapping entry. Sheet column order is the
real nomination rotation, so imported `pick_order` is the true pick order.

## AD-15: Projected auction values come from the league-history value model, computed offline

**Decision.** `player_seasons.projected_auction_value` for a draft year is
produced by the League Value Model (`src/lib/value-model.ts`, run via
`scripts/calc-projected-values.ts`): recency-weighted (decay 0.85) median of
comps within widening rank windows (±2/4/8) over official-auction history — same-
position by position rank plus cross-position by overall rank — normalized so the
top-84 estimates sum to the $2,400 league budget. Parameters were selected by a
walk-forward backtest (2022–2025); methodology and rejected alternatives are
documented in `docs/auction-value-model.md`.

**Why.** The linear rank equation backtests at $11.54 MAE per pick versus $5.67
for the model, systematically overpays QB/TE (blind to positional discounts), and
allocates $3,216 of a $2,400 budget. Weighted median makes single outlier picks
(e.g. the $63 Herbert) harmless; recency weighting carries positional trends
without extrapolating.

**Consequences.** The model is pure and unit-testable; the CLI runner needs
superuser credentials and imported rankings for the target year.

The in-app "Calculate Projected Values" tool no longer applies the linear curve —
it runs this model. Both paths call the same builders (`src/server/lib/value-data.ts`,
moved there from `scripts/` for exactly this) and `computeAuctionEstimates`, so the
button and the CLI produce identical numbers and the old "never press it" warning
is retired. The action is commissioner-gated in `src/server/actions/imports.ts`:
PocketBase's own `player_seasons` write rule
(`@collection.leagues.commissioner ?= @request.auth.id`) can only say "is a
commissioner of some league", so the action narrows it to the commissioner of the
caller's own league and returns a readable error instead of a bare 403. It writes
only the rows whose value actually changed.

Verified against the local instance 2026-07-30: with a league member's own token
(not a superuser) the builders read the identical history a superuser sees — 8
official auctions, 672 priced picks, 3,765 rows — so the in-app button and the
CLI agree; recomputing 2026 produced 0 changes against the CLI-written values,
and a deliberately corrupted row was healed back to the model's number. A
non-member's token reads 0 auctions and the action refuses rather than writing a
history-less board.

The live comps estimator (`src/lib/estimated-value.ts`, the "Target Price" column)
now shares this model's comp collection outright — one `collectComps` in
`value-model.ts` serves both — but stays deliberately un-normalized: a raw market
read next to the budget-scaled Projected Value. Before they were unified the two
had silently drifted: the live side stopped widening at a ±4 window instead of ±8,
and had no auction-position gate on cross-position comps, so a K/DST with an
overall rank could be priced off a skill player. Un-normalized backtests
marginally better per pick ($5.47 vs $5.67 MAE) but carries a −$1.00 bias;
normalized is nearly unbiased and sums to the budget. Both carry explainer
tooltips in the players table and active-player panel.

Rerun after each season's rankings import — estimates key off `rank`. Re-validate
the decay parameter as history grows.

## AD-16: Player headshots are external-ID references, resolved to CDN URLs client-side

**Decision.** `players` gains two optional text fields, `sleeper_id` and
`espn_id` (`pb_migrations/1784120000_player_images.js`), populated offline by
`scripts/sync-player-images.ts` and read (not written) by the app. No image
bytes are stored in PocketBase. `src/lib/player-images.ts` resolves a size-aware
image URL at render time: ESPN's resized combiner endpoint when `espn_id` is
present (~5–8KB), Sleeper's unresized full JPEG as fallback (~70–100KB), a
Sleeper team-logo URL for DST (keyed on `team`, no ID needed), or `null` when
nothing matches. `src/components/player-avatar.tsx` is the single consumer —
memoized, primitive-props-only (drops in in-place inside the already-memoized
players-table row), lazy-loaded, fixed-dimension (no CLS), with an initials
fallback.

**Why.** IDs instead of URLs (or PB file uploads) mean the CDN strategy can
change later without another migration or a re-ingest pass, and hotlinking
immutable CDN assets avoids adding an image-hosting/re-encoding pipeline to a
single-operator app. ESPN is preferred over Sleeper's own headshot path
because Sleeper serves the same full-size file at every requested size — the
draft dashboard's virtualized-table performance work made an ~8x-smaller
image worth a second data source. Sleeper's dump doesn't carry `espn_id` for
most players from 2022+ draft classes, so the sync script backfills those
from the community DynastyProcess ID map (`scripts/.cache/`, gitignored,
re-downloaded on demand) rather than leaving them on the heavier fallback.

**Consequences.** The sync script is a manual, idempotent, re-runnable step
(`--dry-run`, `--force`, `--refresh`) — it is not wired into the CSV import
pipeline, so newly imported players need a re-run before they show a headshot;
until then they render initials, which is a safe default rather than a
failure state. Matching is name+position keyed with a team/active tiebreak
and a small hand-maintained alias table for Sleeper/app name mismatches
(`NAME_ALIASES` in the script); ambiguous or unmatched players are reported
and skipped, never guessed. The draft board (`draft-pick-cell.tsx`) and
team-roster views were deliberately left without avatars — both render 150+
player cells simultaneously with no virtualization, and adding images there
would have worked against the same performance goal this design otherwise
protects.

## AD-17: Leagues, memberships, and invite-only signup

**Decision.** Multi-user support (July 2026, docs/multi-user-plan.md) is built on
three collections (`pb_migrations/1784160000_leagues.js`): `leagues` (name,
`commissioner` relation, `settings` json mirroring `DEFAULT_ROSTER_SETTINGS`),
`league_members` ((league, user, fantasy_team), unique per league-user and
league-team), and `invites` (commissioner-managed tokens). `fantasy_teams` and
`auctions` gained a `league` relation; the existing league, all 12 franchises,
and all auctions were backfilled by the migration. Account creation is
invite-only: `users.createRule` stays null (AD-2) and the `signupWithInvite`
server action (`src/server/actions/signup.ts`, `/signup?token=…` page) validates
the invite, creates a verified user, and binds the membership. The commissioner
manages members and invite links in the Admin → League tab.

`commissioner` is a direct relation on `leagues` rather than a role on the
membership row because PB multi-relation rule conditions are not row-correlated
— `league.commissioner = @request.auth.id` is the only admin check that can't
match across two different rows.

**Why.** One league today, but team-to-user binding and league settings as rows
(not constants) is what makes a second league additive instead of a rework. The
signup action requires a standing superuser credential in `.env`
(`PB_SUPERUSER_EMAIL`/`PB_SUPERUSER_PASSWORD`) — a deliberate deviation from
AD-13's ephemeral-superuser stance, accepted because PB rules cannot validate an
invite token against another collection during user creation.

**Consequences.** `USER_TEAM_ID` is gone (retiring AD-9's flagged debt):
`useUserTeamId()` / `useLeague()` / `useDraftRole()` (`src/hooks/use-league.ts`)
derive the user's team, league settings, and pick-entry role from the selected
auction's league. Commissioner admin surfaces instead use `useCommissionerLeague()`
to resolve the administered league directly, so league management remains available
without any auction selected. `activeAuction` in the auction context is the default owned
active selection, not proof of uniqueness: each owner may have at most one active
draft per type, while an official and a mock draft may coexist. Same-type
replacement requires an explicit complete/delete action, and pick writes/sim
gating key off `selectedAuction`. Reference-data writes (players/player_seasons/
fantasy_teams) tightened from any-authed to commissioner-gated
(`@collection.leagues.commissioner ?= @request.auth.id`) — imports still run
under the commissioner's token.

## AD-18: Two-lane draft-pick authorization; league members read official auctions

**Decision.** Pick entry is hybrid (migration
`pb_migrations/1784180000_two_lane_pick_rules.js`): the auction owner or league
commissioner writes picks for any team (they run the draft, covering teams not
using the app); a member bound to a team may create picks only for that team, in
active official auctions of the team's own league. Update/delete (price edits,
undo) stays owner/commissioner-only (AD-10 intent). All league members can read
official auctions, their team order, and picks live (the existing SSE realtime
sync just works); mock auctions remain private to their owner. The UI mirrors
the lanes (`useDraftRole`): members get an own-team-locked confirmation modal,
own-turn-only snake entry, and an on-the-clock indicator in the tier-2 ticker
(AD-22; the standalone banner is gone). PocketBase hooks enforce
member nomination turns and unpriced snake-pick turns. A priced auction pick is
deliberately not nomination-turn-gated: it belongs to the winning bidder, who
is usually not the nominator, while the collection rule still limits a member
to recording only their own team's win.

**Why.** The league runs one live draft with one authoritative room; the app's
job is letting the admin record everything while letting present members enter
their own picks. The own-team-only rule is the enforcement; no member can write
another team's pick regardless of what any client sends.

**Consequences.** Cross-user isolation and both lanes were verified with a
second account (member, non-member, second-league commissioner, cross-league
write attempts). Members see multiple auctions including foreign active ones —
any client logic must treat owner-scoped `activeAuction` as the default active
selection, not a uniqueness proof; explicit `selectedAuction` remains the source
of truth for the current draft.

## AD-19: pick_order is assigned by a PocketBase hook (supersedes AD-8)

**Decision.** `pb_hooks/draft_picks_pick_order.pb.js` assigns `pick_order =
max + 1` per auction inside every API create; clients no longer send it.
Superuser-provided orders are respected (the historical import script writes
explicit workbook orders). Two unique indexes back it up
(`pb_migrations/1784170000_draft_pick_unique_indexes.js`): (auction_id,
pick_order) and (auction_id, player_id); `useCreateDraftPick` retries once on an
order collision. The migration also repaired the 2025 Draft, whose live entry
through the AD-8 client-side path had produced duplicated/gapped orders —
renumbered 1..N ordered by (pick_order, created, id), a one-way edit of a
completed auction justified as data repair.

**Why.** AD-8 explicitly deferred multi-writer ordering to "a serialized
authority"; two-lane writes (AD-18) made that day arrive. A hook keeps the
assignment inside PocketBase where both lanes converge, and the unique indexes
turn any residual read-then-write race into a clean retryable 400 instead of
silent corruption (verified with concurrent creates).

**Consequences.** `pb_hooks/` is a second deployment artifact with the same
copy-into-instance-and-restart workflow as `pb_migrations/`. The mock-draft
sim's local pickOrder counter survives only as an engine RNG seed input; the
snake modal's pickOrder prop is display-only. Snake turn derivation uses the
selected league's `paidAuctionSlots` and the auction's actual team count; golden
tests execute the marked PocketBase-hook copy against the shared TypeScript
implementation so configurable settings cannot silently drift server/client
turn authority.

## AD-20: Official-auction nominations are an immutable shared event stream

**Decision.** `auction_nomination_events` stores `nominate` and `clear` events
for active official auctions. PocketBase assigns a monotonic `event_order` per
auction and snapshots `pick_count` on every event. The highest-order event is
current only while the auction still has that many picks; recording a pick
therefore resolves the nomination for every client through the existing pick
SSE. Events are append-only and realtime sync patches
`['auction-nomination', auctionId]`. Mock-draft nominations stay local to the
deterministic sim context.

League members can read nomination events for their official auction. PocketBase
requires the event's `user` to match the authenticated user, and
`pb_hooks/auction_nomination_permissions.pb.js` requires a non-commissioner to
be the current nominating team. A member may replace or clear only their own
still-active nomination; the commissioner can operate the room for any team.
Keeping this state in a separate collection avoids giving members broad update
access to `auctions`.

**Why.** `ActiveDraftContext` previously held the nominated player only in React
state, so different users could see completed picks in realtime but not the player
currently up for auction. An event stream makes nominate, replace, clear, and sale
transitions converge without a mutable singleton row or cross-user overwrite race.

**Consequences.** Deploying this feature requires migrations
`1784190000_auction_nomination_events.js` through
`1784210000_allow_zero_nomination_pick_count.js` and the canonical hook copied
into the PocketBase instance's `pb_hooks/` directory. The sequence avoids
millisecond timestamp ambiguity in rapid nominate/clear writes. A reconnect
reads the latest event, and a draft-pick realtime event clears an older
nomination even if an SSE event was missed while the client was offline. The
nomination rotation's marked hook copy is executed by the same golden suite as
`getNominatorForPick`, including slot-limit skip cases, to make drift a test
failure rather than a live-draft authorization mismatch.

## AD-21: Active draft replacement is explicit and scoped by type

**Decision.** Each owner may have at most one active draft of each type (official
or mock), while an official and a mock draft may be active at the same time.
Creating a draft never auto-completes or deletes another draft. Replacing an
active draft of the same type requires an explicit complete or delete action.
`activeAuction` is only the default owned active selection, not proof of
uniqueness.

**Why.** Official auctions are shared league records with live member writes and
realtime readers, while mock drafts are independent workspaces. Starting either
must not silently end an existing draft or turn it read-only; same-type lifecycle
changes remain visible and deliberate.

**Consequences.** Create surfaces the same-type conflict and leaves completion or
deletion to an explicit lifecycle action. Selection code may use `activeAuction`
as a default, but must use `selectedAuction` for the current draft. An explicit
selection survives that draft completing: the record becomes read-only history in
place and `useCompletedDraftRedirect` moves the viewer to the archive of the same
draft, so a member watching an official draft end sees the final board instead of
being dropped on the landing page. `realtime-sync` subscribes to the selected
auction record for this — a completion emits no pick or nomination event.

## AD-23: Draft-room chrome keys off one predicate; enterability is narrower than readability

**Decision.** `useIsDraftRoom()` (`src/contexts/navigation-context.tsx`) is the
single definition of "in the live pick-entry surface": an active `selectedAuction`,
no `landingOverride`, and not the `draft-history` view. Nav tabs, the watchlist
sidebar, and the live ticker all render off it. Separately, the drafts a user may
*enter* or archive (`accessibleActiveAuctions`, draft history) are official drafts
plus their own — a strict subset of what the `auctions` list rule returns.

**Why.** The chrome predicate was duplicated in three components with three
slightly different spellings, which is a drift bug waiting to happen. And the
list rule grants a commissioner read access to every auction in their league,
*including members' private mocks* (AD-18) — that access exists for oversight, not
to put someone else's mock on the commissioner's landing page or in their history.

**Consequences.** Read access and enter/archive access are deliberately different
sets; new surfaces that list drafts must filter by `type === 'official' || user ===
me` rather than trusting the query result. Leaving the draft room only changes the
view — the mock sim keeps resolving AI-only picks in the background, and still
stops at the user's own nomination or pick, so nothing is decided in absentia.

Switching drafts is now a routine action, which makes per-draft state that is
*cleared by an effect* a hazard. `pending` in `mock-draft-context.tsx` carries the
`auctionId` it was generated for and is invalidated by derivation instead: the
AI-nomination effect is declared before any reset effect, so on the single commit
that switches drafts a reset effect would wipe the nomination just set, leave
`pending` unchanged at `null`, change no dependency, and deadlock the sim on
"…is nominating" until a reload. Per-draft state added later must follow the same
rule. The selected auction id is persisted to `localStorage` (restored in an
effect, never a lazy initializer — reading storage during the first render breaks
hydration against the prerendered HTML) so a reload returns to the draft being
viewed rather than whichever owned active draft sorts first.

## AD-22: All draft chrome lives in a two-tier top navbar; sidebars are gone

**Decision.** `src/components/top-navbar.tsx` replaces the 64px left icon rail,
the active-draft banner, the "Now up for auction" w-96 panel, and the mock-draft
w-96 panel. Tier 1 is view tabs + settings + watchlist toggle + sign-out (logo
links to Players). Tier 2 is a live-draft ticker shown for the selected active,
non-read-only auction, with three variants switched by auction kind: `AuctionTicker`
(active player, PROJ/TARGET/YOUR MAX, bid input → DraftConfirmationModal),
`SnakeTicker` (on-the-clock / up-next / pick #), and `SimTicker` (the full sim
state machine — nominations, Pass/Bid, user-nominate and snake prompts,
auto-advance, pause/resume, complete). During a sim, row actions nominate or
snake-pick directly (no staging step, no snake modal); `PlayerActionButton`
derives enabled state from the sim's status (`user-nominate`/`snake-user`)
instead of the real-auction `canNominate`/`canSnakeDraft` lanes. Player
history/comps formerly in the w-96 panel remain reachable via the PlayerDetail
modal. The WatchlistSidebar is the only surviving sidebar.

**Why.** One consistent location for live-draft state across official auctions,
mock drafts, and sims; the left rail and two w-96 panels duplicated each other
and consumed horizontal space the draft board needs.

**Consequences.** View switching stays in `NavigationContext` (AD-12) — the
navbar is a consumer, not a router. Any new live-draft UI attaches to the
ticker variants, not a new panel. `app-content.tsx` renders
`[main][WatchlistSidebar?]` only; deleted: `sidebar.tsx`,
`active-draft-banner.tsx`, `active-player-panel.tsx`,
`active-player-history-sections.tsx`, `mock-draft/mock-draft-panel.tsx`.

## AD-23: Sim user picks are guarded by a turn-aware spam ref

**Decision.** `submitSnakePick` in `mock-draft-context.tsx` sets
`pendingUserSnakeRef` on submit and releases it only when the pick is visible
in the picks cache AND the derived turn has moved off the user (or when the
POST fails, or the auction/sim context changes, so a failure can't wedge the
guard). `busyRef` alone was insufficient: a fast local PocketBase completes the
POST and releases it before the cache/realtime update lands, and releasing on
cache-visibility alone is still one render before the derived state flips —
both windows let a rapid second click pass the stale `currentTeamId` check and
steal the next team's turn (observed in the DB as consecutive picks for the
user's team).

**Why.** `pass`/`counter`/`nominate` already self-guard by clearing `pending`
synchronously; the snake path had no synchronous state flip, so it needed an
explicit one.

**Consequences.** User snake picks are idempotent under click spam; a failed
POST shows the mutation error toast and the user can immediately retry.

## AD-24: Auction deletes cascade in PocketBase, not in app code

**Decision.** `draft_picks.auction_id` has `cascadeDelete: true` (migration
`1784320000_draft_picks_cascade_delete.js`), matching `auction_teams.auction_id`.
`deleteAuction` now deletes only the auction record and lets PocketBase remove
the picks.

**Why.** `draft_picks.deleteRule` requires `auction_id.status = "active"` — the
guard that keeps completed drafts immutable (AD-10). `deleteAuction` used to
delete each pick by hand first, which meant any *completed* draft that had
picks could never be deleted: the first pick delete returned 403 and the whole
action threw. Cascading sidesteps the per-pick rule because PocketBase performs
the deletion itself, so immutability still holds on every path a user can
actually reach.

**Consequences.** Deleting an auction is one request. Any future code that
needs to remove picks from a completed draft still cannot do so through the
API — that is deliberate. `replaceAuction` keeps its explicit pick deletes:
it operates on an *active* auction, where the rule is satisfied.

## AD-25: GSIS anchors player identity; weekly stats are imported raw

**Decision.** `players.id` remains the app's PocketBase relation key, while
`players.gsis_id` is the canonical external football-data identifier.
Provider-specific IDs (`fantasypros_id`, `sleeper_id`, and `espn_id`) remain
stored on the same row; they are useful provider handles, not replacements for
GSIS. An offline reconciliation script fills missing IDs from the
DynastyProcess player-ID crosswalk. It prefers exact existing-ID matches,
allows only an unambiguous normalized name-and-position fallback, and never
overwrites a conflicting non-empty ID.

Per-game player stats are imported from nflverse's weekly player-stat files
into `player_game_logs`. Each row is unique by player and game, records season,
week, season type, teams, and selected raw scoring inputs in JSON. Authenticated
clients may read logs; only a PocketBase superuser import may create or change
them. The browser never calls nflverse or FantasyPros for game logs.

**Why.** GSIS is present in nflverse play/player data and provides a stable
join independent of any fantasy vendor. Keeping provider IDs avoids lossy
on-demand resolution. Storing an app-owned snapshot protects the UI from
upstream outages, quota changes, and credential exposure. Raw inputs preserve
reproducibility and let standard, half-PPR, or full-PPR points be calculated
from one row instead of persisting three vendor-specific totals.

**Consequences.** Game-log imports must follow ID reconciliation and report
unmatched GSIS rows rather than guessing. Re-running either script is safe:
existing correct IDs are skipped and game logs upsert by player/game. Scoring
rules stay app-owned and may evolve without re-importing source data. Team
defense logs remain out of scope until a defense scoring model and team-ID join
are defined.

## AD-26: Both phases snake, but each phase starts its own snake

**Decision.** Turn order snakes within the auction nominations and within the
post-auction rounds, but the two phases are separate snakes. Nomination round 1
runs draft order 1..12, round 2 runs 12..1 (so team 12 nominates the last pick of
round 1 and the first of round 2). The snake phase then **restarts**: the first
post-auction pick goes to draft order 1 regardless of which direction the
nomination rotation ended on, and alternates from there.

**Why.** The live draft this app models snakes its nominations — the app ran a
plain round-robin, which wrapped 12 back to 1 — but it does not carry that
alternation across the auction/snake boundary: once the auction completes, the
snake starts over at the first overall team. Treating the boundary as just
another round boundary (the original AD-26 rule) handed the first snake pick to
team 12 for the default 7-slot/12-team league.

**Consequences.** One function expresses the rule: `snakeSlotIndex(slot,
teamCount)` in `src/lib/snake-draft.ts`, mapping a 0-based *within-phase* turn
counter to a team slot. `calculateCurrentSnakeTeam` calls it with
`totalPicks - paidAuctionSlots * teamCount`, and `getNominatorForPick`
(`src/lib/draft-turn.ts`) calls it with the nomination cursor. The old `isSnakeRoundReverse` / `getSnakeTeamOrder` pair is gone — both
were private to `snake-draft.ts`, and their auction-phase guards described a
phase split that no longer exists. Because a snake turn repeats one team at each
round boundary, the snake sequence has period `2 * teamCount`, and the
nomination skip scan must span a full period: a shorter window can report "every
team is full" while a team with open slots sits just past its end, stranding the
auction with no legal nominator. Both marked hook copies
(`auction_nomination_permissions.pb.js`, `draft_picks_pick_order.pb.js`) inline
`snakeSlotIndex` — the PocketBase JSVM cannot import — and
`src/lib/draft-turn.golden.test.ts` executes them against the shared functions.
Deploying requires copying both hooks into the PocketBase instance's `pb_hooks/`
and restarting.

## AD-27: Team profiles are computed-only and model the snake rounds too

**Decision.** A `TeamProfile` is derived entirely from league history — there is no
manual override layer — and it now describes three families of tendency rather than
one. Auction stats (`posBudgetShare`, `aggression`, `concentration`) come from the
priced picks as before. Snake stats (`snakePosBias`, `snakeReach`, `runResponse`)
come from the `price = 0` snake-round picks. Affinity stats (`nflTeamBias`,
`rookieBias`) come from every pick of both phases. Every stat is shrunk toward the
league average with the same `SHRINK_K = 8`.

**Why.** The 2018–2025 snake rounds were backfilled (AD-13), and until now the
profile code filtered them out with `price > 0` — so `chooseSnakePick` read nothing
from the profile and every AI team played rounds 8+ identically, strict
best-available. A simulated mock stopped resembling the real draft at the auction
boundary. The three snake stats are the tendencies the pick data can actually
support: which positions a manager front-loads, how far past best-available they
reach, and whether they chase a positional run. NFL-team and rookie leanings show up
in both phases, so they are measured over the pooled picks and applied to both.

**Consequences.** Snake picks are decay-weighted `1 / (1 + k)` over a team's snake
picks that year: the early rounds reveal preference, the late ones are mandatory
roster filling every team does the same way. `snakeReach` is measured against a
per-draft suffix-min of `rank` (the best player still on the board), so it needs
rank data and skips 2018. `nflTeamBias` is sparse — only leans past 5% are stored —
and abbreviations are normalized (`OAK→LV` etc.). One shared `playerAffinity` helper
in `profiles.ts` feeds both `chooseSnakePick` and `computeWtp`, and `WtpBreakdown`
gained an `affinity` factor so "why this price" stays a complete factorization.
`chooseSnakePick` now takes the recent pick positions for run detection and sizes
its candidate pool from `snakeReach` instead of a fixed top-3.

A positional bias is a *rate*, so applying it as a constant per-pick multiplier
compounds: the pull is never decremented by the picks it causes, and the first
full-board sim had two QB-leaning teams rostering five and six quarterbacks. Two
guards fix it, both in `snakeNeed`/`chooseSnakePick` rather than in the stat: depth
need decays as `0.3 / (1 + depthBeyondStarters)` using the new
`TeamState.countByPosition`, and `BENCH_ALLOWANCE` caps the roster at one backup QB
or TE and no second K/DST (RB/WR uncapped, since that is where real benches go).
`scripts/sim-mock-draft.ts` is the harness that catches this class of bug — per-pick
unit tests are blind to anything that compounds over a draft.

The rookie flag this depends on only existed for 2025;
`scripts/backfill-rookie-flags.ts` fills 2019+ from the nflverse game-log debut
season, additively (it never clears a flag it can't derive). 2018 is out of reach —
the log window opens there.

The `team_profiles` collection and its rows still exist in PocketBase but nothing
reads or writes them; the profiles view is a read-only visualization. Dropping the
override layer removed `applyOverrides`, `TeamProfileOverrides`, and the two
override hooks. If manual tuning is ever wanted again, the collection is still there.

## AD-28: Full-PPR rankings use temporary parallel season columns

**Decision.** Keep one `player_seasons` row per player and year. Existing `rank`,
`position_rank`, `tier`, and `ecr_vs_adp` remain the legacy board used by
standard and half-PPR leagues; parallel nullable `*_ppr` columns hold the
full-PPR board. Team, bye week, strength of
schedule, and rookie status remain shared facts. Reads flatten the column set
matching the selected league's scoring format, and rankings imports require an
explicit Half-PPR or Full-PPR destination that matches the selected league.

**Why.** Changing the uniqueness key or introducing a second ranking row would
re-key every board, history, watchlist, draft-pick hydration, value-model, and
import path during draft preparation. Parallel columns add the needed full-PPR
board without making any existing query return duplicate or ambiguous season
rows.

**Consequences.** This shape is explicitly temporary. Before the 2027 rankings
import, split season facts, format rankings, and league values into
`player_seasons` (player + year), `player_season_rankings` (player + year +
format), and `league_player_values` (league + player + year). Until then,
`projected_auction_value` remains on `player_seasons` and is valid for at most one
auction-or-hybrid league per `(year, scoring format)`; snake leagues neither
write nor read it. Standard and Half-PPR share the legacy columns, so one
league's import overwrites the other's board for that year — the import view
warns, and the per-format split above ends it. The migration keeps the
`(player_id, year)` unique index unchanged.

**ADP presence (NFI-81).** ADP is derived as `rank + ecr_vs_adp` from the
selected scoring board, never stored. PocketBase number fields default to zero,
so `ecr_vs_adp_known` and `ecr_vs_adp_ppr_known` preserve whether the source
actually supplied a delta. Missing columns, blank cells, and invalid deltas clear
the selected board's delta and marker on import, rather than combining a stale
delta with a new rank. That clearing is the one exception to "absent means leave
alone": importing a partial CSV without a delta column wipes ADP for every player
in that year until a full export is re-imported, and the ADP column plus the
survival signal go blank with it. Mappers expose unknown deltas as `null`; known
zero remains a valid comparison value. Only integer deltas count as known —
FantasyPros deltas are whole picks, and a fractional value would be discarded as
unknown rather than rounded, which is the safe direction. Migration backfills
only nonzero deltas: historical zeros are ambiguous and require source reimport
before ADP can be shown. ADP also remains unavailable for missing/invalid ranks
or nonpositive derived values.

## AD-29: League selection scopes drafts and every history-derived computation

**Decision.** Draft lists, available teams, historical prices, and computed manager
profiles are keyed and filtered by the selected league. Draft creation sends that
league explicitly and verifies membership, commissionership for official drafts,
and team ownership before writing. The active-draft invariant from AD-21 is now
one active draft per **league, owner, and type**, enforced by the lifecycle action
and a matching partial unique index.

The history and value-model loaders scope official drafts **before** choosing one
per year or synthesizing undrafted players. The unused imported-season-price
fallback is removed: shared season rows cannot identify the source league.
Recalculation and both value-model CLI runners share the scoped loader; both
scripts require `--league`, including offline runs. A dump must include the league
and team metadata needed to select its inputs and settings.

External boards retain their import contract of 12 teams, a $200 budget, and seven
paid slots. They supply comps only to auction or hybrid leagues with that exact
shape, and never supply a league's manager profiles. Snake leagues generate no
auction-price history or projected-price writes. The declared `draftFormat`, not
a paid-slot heuristic, determines the format; missing settings still default to
`hybrid` without a backfill.

**Why.** A user may legitimately read multiple leagues. API authorization cannot
stop a newer completed draft from another league displacing the intended draft
in an unscoped same-year collapse. Query scoping prevents that corruption, while
league-keyed caches prevent old results surviving a league switch.

**Consequences.** Integration tests use a member of both leagues and completed
official drafts in the same season, checking prices, synthesized comps, profiles,
and member/superuser loader parity. The active-draft index change is reflected in
both the incremental migration and the baseline. Rolling it back requires the
older, stricter active-draft invariant to hold; rollback never ends drafts.

The AD-28 storage limitation remains: there is only one projected-price column
per player and year, not one per scoring format or league. Isolated computation
does not make that column capable of storing multiple auction leagues' results
at once. Supporting that requires the planned `league_player_values` split; the
current auction-plus-snake pairing does not introduce a second price writer.

## AD-30: Snake draft rooms hide auction chrome, predict survival, and draft in one click

**Decision.** One predicate — `useIsSnakeLeague()`, derived from the league's
declared `draftFormat` — gates every piece of auction chrome in a snake-format
league: budget and max-bid summaries, team budget pressure, the nomination lane
plus nominated-player state and its realtime subscription, price entry, inline
auction-value editing, projected/actual price columns, the comps distribution
and price-history sections, and the price-shaped analysis view. The draft board
shows round and pick (`R3 · P7`) in place of price. Tier-cliff alerts carry over
untouched. The board and watchlist flag players unlikely to survive to the
user's next snake turn, from derived ADP and the snake rotation, with no
prediction for players lacking ADP and no signal at all when the board carries
no ADP data. The row and watchlist Draft buttons record the pick immediately
for the team on the clock — no modal — preserving the two pick-entry lanes
(commissioner any team, member own team on own turn); the pick-entry path keys
off the format predicate (`isSnakeLeague || isSnakeMode`), never the phase
toggle alone. Clicking an empty board cell still opens the picker modal — that
surface chooses the player rather than confirming one, so one-click does not
apply to it.

**Why.** Every auction affordance is meaningless without prices and several are
actively misleading ($0 budgets, blank price cells). The format predicate —
not the phase toggle — drives the gates so hybrid snake-phase rooms keep their
auction chrome. Survival is the format's highest-value signal: the decision is
never "who is best" but "who will not last". One-click entry fits a 168-pick
draft moving far faster than an auction, where the commissioner records while
drafting.

**Consequences.** Known limitation, documented not fixed: `pick_order` is
assigned as one past the current maximum while the snake turn derives from the
pick count, so deleting a mid-draft pick and re-entering it lands it at the end
of the order — the count stays right but that player shows in the wrong round.
Undoing the most recent pick is clean. Fixing the general case means
renumbering, which touches the pick-order hook and its unique index, both
load-bearing for the existing league's imported history.
