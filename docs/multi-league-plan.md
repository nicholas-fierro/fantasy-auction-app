# Multi-League Plan: League Isolation, League Selection, and Snake-Format Leagues

Design + build order for running the app across more than one league, where the
second league is a **12-team full-PPR snake** draft with no auction phase, and
league history must not cross-contaminate.

Companion decision log: `ARCHITECTURE_DECISIONS.md`. This plan finishes the
"multi-league shape" goal `docs/multi-user-plan.md` declared and deliberately
left one league deep (AD-17), and it retires the single-league assumptions that
survived it.

## Goals

1. **A user belongs to many leagues** — commissioner of one, plain member of
   another, in any combination.
2. **History is isolated per league** — the hybrid league's auction prices never
   inform the snake league's numbers, and vice versa. Isolation is enforced in
   the queries, not left to "there is only one league" being true.
3. **League selection is an explicit step** — a league landing surface ahead of
   the draft landing surface, putting a league into context before a draft is
   chosen. A user with exactly one league never sees it.
4. **Format-aware decision support** — a full-snake league shows ADP-driven
   guidance (ADP, ADP vs ECR, positional runs, who survives to your next pick)
   and no auction chrome (budget, max bid, Projected Price, Target Price,
   nominations).
5. **Watchlist stays user-level.** Explicit non-goal to scope it — the players
   you like are the players you like. Its one auction-flavored field
   (`market_nudge`) is simply inert in a snake league.

Explicit non-goals (v1): in-app live bidding (unchanged from AD-17), more than
one *auction* league (see the `projected_auction_value` decision below), and
cross-league analytics.

## Current state

What already generalizes:

- `leagues` / `league_members` / `invites` exist, and `fantasy_teams.league` and
  `auctions.league` are real relations (AD-17). A second league's 12 franchises
  are just 12 more rows.
- League settings are a JSON blob on the row, already read through
  `useLeague()` and merged over `DEFAULT_ROSTER_SETTINGS`.
- Two-lane pick authorization (AD-18) is league-correlated at the rule level:
  `fantasy_team_id.league = auction_id.league` is already required.
- The app already drafts snake rounds — the hybrid draft's post-auction rounds
  use `src/lib/snake-draft.ts`, `snake-draft-pick-modal.tsx`, and
  `mock-draft/snake-ai.ts`. A full-snake league is that machinery with the
  auction phase removed, not new machinery.
- `player_game_logs` + `src/lib/fantasy-scoring.ts` already derive points for
  `std` / `half` / `ppr`, so full-PPR scoring needs no new stat pipeline.

What is hardcoded to one league (the actual work):

| # | Location | Assumption |
|---|---|---|
| 1 | `src/lib/history-client.ts` `computeHistoricalValues()` | reads **all** readable official auctions, no league filter |
| 2 | `src/hooks/use-history.ts` | query key `['historical-values']` has no league |
| 3 | `src/hooks/use-team-profiles.ts` | all `fantasy_teams`, all official auctions, key `['computed-profiles']` |
| 4 | `src/hooks/use-fantasy-teams.ts` `useAllFantasyTeams()` | all teams in every league, key `['fantasy-teams']` |
| 5 | `src/contexts/auction-context.tsx` | `auctions` fetched unfiltered; `activeAuction` is "first owned active draft" regardless of league |
| 6 | `src/server/lib/value-data.ts` `loadFromPocketBase()` | official auctions unfiltered — used by the in-app recalc *and* both CLI scripts |
| 7 | `src/hooks/use-players.ts`, `pb-mappers.ts` `ensureSeasonMap()` | one `player_seasons` board per year for every league, regardless of scoring format |
| 8 | `src/server/actions/auctions.ts` `resolveLeagueId()` | "first membership wins" (its own comment says a picker is needed) |
| 9 | `src/hooks/use-league.ts` `useCommissionerLeague()` | `getList(1, 1)` — a user commissions at most one league |
| 10 | `src/server/lib/import-core.ts` `calculateProjectedValuesCore()` | narrows to "the caller's own league", singular |
| 11 | `fantasy_teams` list/view rule (`@request.auth.id != ""`) | every authenticated user reads every league's teams |
| 12 | `src/lib/snake-draft.ts` | `paidAuctionSlots <= 0` throws / returns null — a pure-snake league is currently unrepresentable |
| 13 | `src/components/league-view.tsx:457` | settings validation rejects `paidAuctionSlots <= 0` |

Items 1–6 and 11 are the isolation bleed. Item 7 is the scoring-format
collision. Items 12–13 are what blocks a pure-snake draft from existing at all.

## Data model

### `leagues.settings` gains a format

```ts
// src/lib/roster.ts
export type DraftFormat = 'auction' | 'hybrid' | 'snake';

export interface RosterSettings {
  // …existing…
  draftFormat: DraftFormat;   // default 'hybrid' for the existing league
}
```

`hybrid` = today's league (paid auction slots, then snake rounds). `snake` =
the new league (`paidAuctionSlots: 0`, every round snake). `auction` is defined
now so the enum is honest, even though nothing selects it yet.

`settings` is a JSON column, so this is a code + UI change, not a migration.
`mapLeagueRecord()` already merges field-by-field over
`DEFAULT_ROSTER_SETTINGS`, so an existing row with no `draftFormat` reads as
`hybrid` with no backfill. **Do not derive the format from
`paidAuctionSlots === 0`** — the derivation and the stored value would drift the
first time someone edits settings, and the format gates authorization-adjacent
behavior (nomination events, price writes).

New-league defaults for the snake league: `budget: 0`, `paidAuctionSlots: 0`,
`minimumBid: 0`, `scoringFormat: 'ppr'`, `starterPositions` and `benchSize` per
that league's rules, `draftFormat: 'snake'`.

### `player_seasons` gains a scoring format and ADP

The two leagues need different boards for the same season: half-PPR ECR for the
hybrid league, full-PPR ECR + ADP for the snake league. Today
`player_seasons` is unique on `(player_id, year)`, so importing a full-PPR
rankings CSV would silently overwrite the half-PPR board.

Migration (`pb_migrations/17845xxxxx_player_season_formats.js`):

- add `scoring_format` (text, required, one of `std` / `half` / `ppr`),
  backfilled to `"half"` on every existing row;
- add `adp` (number) and `adp_source` (text, e.g. `fantasypros` / `derived`);
- drop `idx_player_seasons_player_year`, create
  `idx_player_seasons_player_year_format` on
  `(player_id, year, scoring_format)`;
- reflect all of it in `1784300000_baseline_full.js` (CI parity check).

Every read that keys a board by year becomes keyed by `(year, scoringFormat)`:
`useAllPlayers()`, `seasonRowsQueryKey()`, `fetchSeasonRowsForYear()`,
`ensureSeasonMap()`, `history-client.ts` `buildSeasonMap()`, and
`use-team-profiles.ts`. The scoring format comes from the selected league's
settings, so the two leagues resolve to two different boards without either
knowing the other exists.

### `projected_auction_value` — scoped now or documented now?

`projected_auction_value` lives on `player_seasons`, but it is a *league-derived*
number: it is a recency-weighted median of that league's own auction history,
normalized to that league's budget (AD-15). It is not reference data, and it has
no correct value independent of a league.

**Recommendation: document the constraint now, migrate later.** After the
format key above, `projected_auction_value` is written on the `half` rows and
read by exactly one auction-format league; the snake league writes and reads
none (no prices, no budget, column hidden). Nothing bleeds. The invariant to
write into `ARCHITECTURE_DECISIONS.md` is:

> `player_seasons.projected_auction_value` is valid for **at most one
> auction-or-hybrid league per (year, scoring_format)**. A second auction league
> sharing a scoring format requires moving this field to a league-scoped
> collection first.

The correct end state, when that day comes, is a `league_player_values`
collection — `(league, player_id, year, projected_auction_value)`, unique on
`(league, player_id, year)` — which is a genuinely invasive change (mappers, the
players table, the value model runners, both CLI scripts, the mock-draft
pricing layer). Doing it *now*, for a league that will never store a price, is
paying that cost for no behavior change. Doing it *speculatively wrong* is
worse than doing it late with a stated invariant and a test that asserts it.

If you would rather be correct-by-construction up front, this is the one
decision in the plan to flip — see **Open decisions**.

### Nothing else changes shape

`players`, `player_game_logs`, `watchlist`, `draft_picks`, `auction_teams`,
`auction_nomination_events`, `invites`, `league_members` keep their schemas. The
snake league's picks are `draft_picks` rows with `price = null`, exactly like
today's snake rounds.

## Isolation

The rule layer cannot do this job alone, and shouldn't be asked to: a user who
is legitimately a member of both leagues is legitimately allowed to read both.
Isolation is therefore a **query-scoping** property, with rule tightening as
defense in depth.

### Query scoping

Every league-scoped read takes a `leagueId` and carries it in the query key:

| Query | Today | After |
|---|---|---|
| auctions list | `['auctions']`, unfiltered | `['auctions', leagueId]`, `filter: league = leagueId` |
| historical values | `['historical-values']` | `['historical-values', leagueId]` |
| computed profiles | `['computed-profiles']` | `['computed-profiles', leagueId]` |
| all fantasy teams | `['fantasy-teams']` | `['fantasy-teams', leagueId]`, `filter: league = leagueId` |
| players board | `['players', year]` | `['players', year, scoringFormat]` |
| season rows | `['player-seasons', year]` | `['player-seasons', year, scoringFormat]` |

`computeHistoricalValues(leagueId, scoringFormat)` filters official auctions on
`league = {:leagueId}`. The `imported` (`actual_auction_value`) branch is legacy
and empty (AD-13), but it is a global read — scope it to the same league or drop
it in the same pass rather than leaving a second unscoped path behind.

`src/server/lib/value-data.ts` `loadFromPocketBase(pb, { leagueId, scoringFormat })`
gets the same filter, which fixes the in-app recalculation *and*
`scripts/calc-projected-values.ts` and `scripts/backtest-value-model.ts` in one
place — the property AD-15 depends on (both paths price off identical inputs)
holds only if the league filter is added there and nowhere else. Both scripts
gain a required `--league <id>` flag.

### External boards

External auction boards (`external: true`, no `league`) are comp material for
the value model. They are another league's **auction** results, 12-team / $200 /
7-paid-slot shaped, and are meaningless to a full-snake league.

Rule: include external boards only when the target league's `draftFormat` is
`auction` or `hybrid` **and** its budget / paid-slot / team-count shape matches
the board's. The snake league's history query never sees them.
`scripts/import-external-auction.ts` gains a `--scoring-format` flag so its
season joins land on the right board.

### API rules (new migration, reflected in the baseline)

- `fantasy_teams` list/view: tighten from `@request.auth.id != ""` to
  `@request.auth.id != "" && (league.commissioner = @request.auth.id ||
  league.league_members_via_league.user ?= @request.auth.id)`. Note the
  null-relation trap `1784390000_authenticated_reads_only.js` documents — the
  authenticated wrap is mandatory, and every historical team row must actually
  carry a `league` (the AD-17 backfill set them; verify before applying).
- `fantasy_teams` create: drop the `league = ""` escape hatch, which exists only
  for pre-league rows and would let a commissioner create league-less teams.
- `player_seasons` writes stay `@collection.leagues.commissioner ?= @request.auth.id`
  — PB rules cannot tie a `scoring_format` to the caller's own league. The
  narrowing stays where it already is, in `calculateProjectedValuesCore()` and
  the import actions, which must additionally assert that the write's
  `scoring_format` equals the caller's selected league's `scoringFormat`.
  **Accepted risk, stated plainly:** a commissioner of league B can, at the API
  level, write league A's board. That is not new (it is today's rule), it is
  bounded to commissioners, and closing it properly means per-format write rules
  that PocketBase cannot express. Revisit if leagues are ever run by people who
  don't trust each other.

## League context and the landing surface

### `LeagueProvider`

New `src/contexts/league-context.tsx`, mounted in `app-shell.tsx` **above**
`AuctionProvider` (the auction query now depends on the selected league):

```ts
interface LeagueContextType {
  memberships: LeagueMembership[];   // league + role + fantasy_team
  leagues: LeagueInfo[];
  selectedLeagueId: string | null;
  setSelectedLeagueId: (id: string | null) => void;
  selectedLeague: LeagueInfo | null;
  settings: RosterSettings;
  format: DraftFormat;
  isCommissioner: boolean;
  isLoading: boolean;
}
```

Persisted to `localStorage` under `selected-league-id`, restored **in an effect,
never a lazy initializer** — the same hydration constraint AD-23 records for
`selected-auction-id`.

`src/hooks/use-league.ts` is rewritten against this provider:

- `useLeague()` reads the selected league instead of chasing
  `selectedAuction.league`. Invariant: **selecting an auction also sets the
  league** (`enterDraftRoom` sets both), so the two can never disagree; add a
  dev-time assertion rather than silently preferring one.
- `useCommissionerLeague()` → `useCommissionedLeagues()` (plural) plus
  `useIsCommissionerOf(leagueId)`. Every current caller is a commissioner admin
  surface and becomes scoped to the selected league.
- `useUserTeamId()` reads the membership row for the selected league.

`src/server/actions/auctions.ts` `resolveLeagueId()` stops guessing: the client
sends the selected league id, and the action verifies membership (and
commissionership for `type: 'official'`).

### Landing stages

`NavigationContext` gains a landing stage rather than a new `ViewType`:

- `landingStage: 'league' | 'draft'`.
- With **0 or 1** memberships the league stage is skipped entirely — auto-select
  the single league. Existing single-league users see no change whatsoever.
- With 2+ memberships and no persisted selection, the landing renders the new
  `LeagueLanding`: one card per league (name, format badge, your team,
  commissioner badge, live-draft count), plus "Create a league" and "Join with
  an invite link".
- Choosing a league advances to `landingStage: 'draft'` — the existing
  `NoActiveDraftLanding`, now filtered to that league's drafts.
- A "switch league" control in the top bar returns to the league stage and
  clears `selectedAuctionId`.

Switching leagues invalidates every league-keyed query by construction (the key
contains the league id), so no manual cache surgery is needed. The per-draft
state hazard AD-23 describes applies here too: any effect that resets on league
change must be declared **after** the effects that set derived state.

## Creating and joining leagues

Both operations need privileges the client doesn't have (`leagues.createRule` is
`null`; a `league_members` row can only be created by that league's
commissioner). Both belong in `pb_hooks/league_admin_routes.pb.js`, alongside
the existing scoped routes — no superuser credential in the Next.js runtime
(issue #54's shape).

**`POST /api/league-admin/create-league`** (authenticated). One transaction:
create the `leagues` row with `commissioner` = caller and validated `settings`;
create N `fantasy_teams` rows bound to it (names from the request, default
`Team 1…N`); create the caller's `league_members` row, optionally bound to a
team. Validates: team count 2–32, `draftFormat` in the enum, budget/slot
coherence (a `snake` league must have `paidAuctionSlots: 0`; an
`auction`/`hybrid` league must have `budget >= paidAuctionSlots * minimumBid`) —
the same checks `league-view.tsx` runs client-side, restated server-side because
the client's copy is a convenience.

**`POST /api/league-admin/accept-invite`** (authenticated). Today an invite is
only redeemable through signup, so an existing user cannot join a second league
at all. This route reuses the existing `inviteReason()` validation verbatim
(fail-closed, no enumeration oracle), then creates the `league_members` row and
marks the invite used, in one transaction. New page `/join?token=…`: signed in →
confirm and join; signed out → hand off to the existing `/signup?token=…` flow.

`league-view.tsx` (commissioner admin) becomes per-league, reached from the
selected league, and its settings form learns the format field and the
snake-league validation branch.

## Snake-format support

### Snake math with zero paid slots (blocking)

`src/lib/snake-draft.ts` treats `paidAuctionSlots <= 0` as invalid:
`getSnakeRound()` throws, `calculateCurrentSnakeTeam()` returns
`{ currentTeam: null, nextTeam: null }`. Change the guard to `< 0` and let the
phase offset be zero:

- `isAuctionPick(pickOrder, teamCount, 0)` → `pickOrder <= 0` → always false, so
  every pick is a snake pick;
- `getSnakeRound(pickOrder, teamCount, 0)` → `Math.ceil(pickOrder / teamCount)`;
- `calculateCurrentSnakeTeam` starts the rotation at total picks 0.

`getNominatorForPick()` in `src/lib/draft-turn.ts` already returns `null` for
`paidAuctionSlots <= 0`, which is correct for a snake league (there is nothing
to nominate) — keep it, and make sure the two PocketBase hooks agree:

- `pb_hooks/draft_picks_pick_order.pb.js` — unchanged (`max + 1` per auction is
  format-agnostic), but its marked snake block must track the new offset;
- `pb_hooks/auction_nomination_permissions.pb.js` — must reject nomination
  events outright for a snake-format league rather than computing a nominator.

`src/lib/draft-turn.golden.test.ts` executes the marked hook copies against the
TypeScript implementations; extend it with pure-snake cases so a drift here is a
test failure and not a live-draft authorization mismatch (AD-19/AD-20's stated
reason for the golden suite).

Also relax `league-view.tsx:457`'s `paidAuctionSlots <= 0` rejection for the
snake format, and `use-auto-draft-mode.ts` (`auctionPicksTotal = 0` puts the
room in snake mode from pick 1).

### Format gating in the UI

One helper — `useDraftFormat()` off the league context — drives every gate, in
the spirit of AD-23's single-predicate rule. Hidden entirely when
`format === 'snake'`:

- budget and max-bid chrome: `roster-summary.tsx`, `team-budget-pressure.tsx`,
  `team-roster-card.tsx` price lines, `calculateBudgetSummary` consumers;
- nomination: the ticker's nomination lane, `active-draft-context`'s nominated
  player, `use-auction-nomination.ts`, the nomination event subscription in
  `realtime-sync.tsx`;
- price entry: `draft-confirmation-modal.tsx`'s price field,
  `editable-auction-value.tsx`, `mock-bid-actions.tsx`, watchlist
  `market_nudge`;
- price columns: Projected Price and Target Price in `players-table.tsx`,
  `player-comps-distribution.tsx`, the price sections of
  `player-history-sections.tsx` and `player-detail-modal.tsx`;
- price-shaped analysis in `analysis-view.tsx` and the price line in
  `draft-pick-cell.tsx` (which shows the round instead).

Pick entry collapses to `snake-draft-pick-modal.tsx` for every round.

### Snake decision support (what replaces the auction columns)

- **ADP** and **ADP vs ECR** columns in the players table, sortable; the delta
  is the snake league's equivalent of "Target Price vs Projected Price" — where
  the room is likely to take a player versus where he's ranked.
- **Round · pick** on the draft board instead of price.
- **Survival to your next turn**: given ADP and the picks remaining before this
  team's next slot, flag the watchlist/board players unlikely to last. This is
  the highest-value snake-specific feature and it is derivable from data already
  in the client, in the spirit of AD-11 (no new collections).
- **Positional runs**: rolling count of recent picks by position — the snake
  analogue of the auction's budget-pressure signal.
- Tier-cliff alerts (`src/lib/draft-insights.ts`) are already format-agnostic
  and carry over unchanged.

### ADP sourcing

v1: **FantasyPros ADP CSV import**, added as a new import type in
`import-view.tsx` next to rankings/rookies/values, writing `player_seasons.adp`
for the selected league's scoring format via the existing `matchPlayer` /
`loadPlayerIndex` path. Consistent with every other board import, needs no new
runtime dependency, and is commissioner-gated like the rest.

Later: **derived league ADP** — average `pick_order` per player across that
league's own completed official snake drafts, written with
`adp_source: 'derived'`. That is the snake league's version of what the value
model is for the auction league, it is league-isolated by construction, and it
needs at least one completed season of history before it means anything.

A Sleeper ADP proxy route (like `/api/player-injuries`) is a viable third
source but adds an upstream dependency for data a CSV already provides — not in
this plan.

### Mock drafts in a snake league

`mock-draft/snake-ai.ts` already exists and `computeTeamProfiles()` already
derives snake-side tendencies. The engine needs to run with no auction phase and
no pricing layer, and `mock-draft-data.ts` needs the same league scoping as
everything else. A brand-new league has no history, so profiles fall back to
defaults and the AI should draft off ADP with noise — which is the right model
for a room you have never drafted against. Sequenced last: it is the only piece
that is genuinely optional for the first live snake draft.

## Testing

Unit (`npm test`):

- `snake-draft.test.ts` — every function with `paidAuctionSlots: 0`.
- `draft-turn.golden.test.ts` — pure-snake cases across the TS implementation
  and both marked hook copies.
- `value-model` / `estimated-value` — unchanged math, new league-filtered
  inputs.
- Format-gating helper.

Integration (`npm run test:integration`):

- **Cross-league isolation, the headline test**: a user who is a member of both
  leagues computes history for league A and gets zero rows sourced from league
  B's auctions; the same for computed profiles and the fantasy-teams list.
- Rules: a commissioner of B cannot create/update A's `fantasy_teams`,
  `auctions`, or picks; a member of A only is invisible to B entirely.
- The guest case, re-run: `1784390000`'s null-relation trap must not reopen when
  `fantasy_teams` read rules change.
- Migration parity: empty instance from `1784300000_baseline_full.js` vs the
  incremental chain, after the `player_seasons` format migration lands.
- `create-league` and `accept-invite` routes: happy path, expired/used/pinned
  invite, non-member caller.

## Build order

Each phase is independently shippable and leaves the existing league working.

1. **League context, no schema change** — `LeagueProvider`, rewritten
   `use-league.ts`, landing stage (auto-skipped at one membership), fixed
   `resolveLeagueId()`. Single-league behavior unchanged.
2. **Isolation pass** — league-scoped queries and keys, `value-data.ts` +
   both scripts, external-board gating. Ships with the cross-league integration
   test, which is what proves the requirement.
3. **`player_seasons` format + ADP migration** — schema, baseline reflection,
   `(year, scoringFormat)` keying everywhere, format-aware import.
4. **League creation + joining** — two PB routes, `/join` page, per-league
   `league-view.tsx`, format field in settings.
5. **Snake format core** — `draftFormat`, zero-slot snake math, hook alignment
   and golden tests, format-gated draft room, snake-only pick entry. *After this
   phase the second league can run a live draft.*
6. **Snake decision support** — ADP import, ADP columns, survival-to-next-turn,
   positional runs, board and analysis changes.
7. **Snake mock drafts + derived league ADP** — needs phase 6's data and, for
   derived ADP, one completed season.

Rules changes in phases 2 and 4 are each verified with a second account against
both leagues, per AD-2's standing discipline.

## Open decisions

1. **`projected_auction_value` scoping** — document the one-auction-league-per-
   format invariant now (recommended, phased), or move it to
   `league_player_values` in phase 3 (correct-by-construction, materially more
   work for zero behavior change today).
2. **ADP source** — FantasyPros CSV import (recommended) vs a Sleeper proxy
   route.
3. **Snake league roster shape** — starters, bench size, and total rounds for
   the new league, needed for phase 4's creation defaults.
4. **Mock drafts for the snake league** — in scope at all, or drop phase 7?
5. **Historical import for the new league** — is there a past-draft workbook to
   backfill (which would make derived ADP and manager profiles useful
   immediately), or does it start empty?
