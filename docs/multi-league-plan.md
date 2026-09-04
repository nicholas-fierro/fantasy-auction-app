# Multi-League Plan: League Isolation, League Selection, and Snake-Format Leagues

Design + build order for running the app across more than one league. The second
league is a **12-team full-PPR pure snake** draft, and its history must not
contaminate the existing hybrid auction league's.

Companion decision log: `ARCHITECTURE_DECISIONS.md`. This plan finishes the
"multi-league shape" goal `docs/multi-user-plan.md` declared and deliberately
left one league deep (AD-17), and retires the single-league assumptions that
survived it.

## Constraints this plan was designed under

- The snake draft is **days away**. The hybrid league has **already drafted**
  2026, so its draft room is read-only history and its value model's output is
  not consumed live until next season's rankings import. That is what makes the
  shared-surface work tolerable on this timeline.
- The app owner is **commissioner of both leagues**, which breaks two
  single-league assumptions immediately (below).
- Draft day runs on **production**, so the schema and rules changes go through
  the production migration runbook with a backup.
- If the work is not ready and correct by draft day, the draft happens on the
  host platform and this ships properly afterwards. **Nothing on the list below
  gets cut to make a date.**

## Goals

1. **A user belongs to many leagues** — commissioner of one, plain member of
   another, in any combination.
2. **History is isolated per league.** Not a tidiness goal — see the corruption
   path below.
3. **League selection is an explicit step**, auto-skipped for anyone with a
   single league.
4. **Format-aware decision support** — a snake league shows ADP-driven guidance
   and no auction chrome.
5. **Watchlist stays user-level.** Explicit non-goal to scope it. Its one
   auction-flavored field (`market_nudge`) is simply inert in a snake league.

Non-goals: in-app live bidding (unchanged from AD-17), and cross-league
analytics.

## Why isolation is a correctness requirement

Snake picks carry no price and `computeHistoricalValues` filters `price > 0`, so
at first glance the snake league cannot reach the auction value model. It can.

`chosenAuctionsByYear` collapses **all official auctions to one per year**
([src/lib/history-client.ts:31](../src/lib/history-client.ts)), preferring
completed, then newest-created. The moment the snake draft completes there are
two completed official 2026 auctions, and the snake one is newer — so it wins
the collapse. The hybrid league's real 2026 prices drop out of the model
entirely, and the `$0` undrafted-synthesis loop then runs against the snake
board, manufacturing hundreds of fake $0 comps.

The same collapse feeds `use-team-profiles.ts`, so snake teams would land in
hybrid manager profiles.

Completing the snake draft therefore silently corrupts the hybrid league's value
model. Isolation ships in PR 1, before any snake draft can exist.

## Current state

What already generalizes:

- `leagues` / `league_members` / `invites` exist, and `fantasy_teams.league` and
  `auctions.league` are real relations (AD-17).
- League settings are a JSON blob read through `useLeague()` and merged over
  `DEFAULT_ROSTER_SETTINGS`.
- Two-lane pick authorization (AD-18) is already league-correlated:
  `fantasy_team_id.league = auction_id.league`. **Member pick entry works in a
  second league with no new authorization work.**
- `signupWithInvite` already binds a brand-new user to any league, so inviting
  snake-league members costs no new code.
- The app already drafts snake rounds — `src/lib/snake-draft.ts`,
  `snake-draft-pick-modal.tsx`, `mock-draft/snake-ai.ts`. A full-snake league is
  that machinery with the auction phase removed.
- `player_game_logs` + `src/lib/fantasy-scoring.ts` already derive `std` /
  `half` / `ppr` points, so full-PPR scoring needs no new stat pipeline.
- The create-draft modal already has drag-reorder and shuffle for draft order
  ([new-auction-modal.tsx:189](../src/components/new-auction-modal.tsx)).
- The `Draft` action button already exists in snake mode
  ([player-action-button.tsx:66](../src/components/player-action-button.tsx)) —
  it currently routes to a modal.

What is hardcoded to one league:

| # | Location | Assumption | PR |
|---|---|---|---|
| 1 | `history-client.ts` `computeHistoricalValues()` | reads **all** readable official auctions | 1 |
| 2 | `use-history.ts` | key `['historical-values']` has no league | 1 |
| 3 | `use-team-profiles.ts` | all teams, all official auctions, key `['computed-profiles']` | 1 |
| 4 | `use-fantasy-teams.ts` `useAllFantasyTeams()` | all teams in every league | 1 |
| 5 | `auction-context.tsx` | auctions unfiltered; `activeAuction` ignores league | 1 |
| 6 | `value-data.ts` `loadFromPocketBase()` | official auctions unfiltered — feeds the in-app recalc **and** both CLI scripts | 1 |
| 7 | `auctions.ts` `resolveLeagueId()` | "first membership wins" — would attach the snake draft to the wrong league | 1 |
| 8 | `use-league.ts` `useCommissionerLeague()` | `getList(1, 1)` — a user commissions at most one league | 1 |
| 9 | `import-core.ts` `calculateProjectedValuesCore()` | narrows to "the caller's own league", singular | 1 |
| 10 | `player_seasons` | one board per year regardless of scoring format | 2 |
| 11 | `fantasy_teams` list/view rule | every authenticated user reads every league's teams | 2 |
| 12 | `snake-draft.ts` | `paidAuctionSlots <= 0` throws — pure snake is unrepresentable | 4 |
| 13 | `league-view.tsx:457` | settings validation rejects `paidAuctionSlots <= 0` | 4 |

Items 7 and 8 are the ones that break the instant a second commissioned league
exists: both silently pick the wrong league.

## Data model

### `leagues.settings` gains a format

```ts
// src/lib/roster.ts
export type DraftFormat = 'auction' | 'hybrid' | 'snake';

export interface RosterSettings {
  // …existing…
  draftFormat: DraftFormat;
}
```

`hybrid` = today's league. `snake` = the new one (`paidAuctionSlots: 0`, every
round snake). `auction` is defined so the enum is honest.

`settings` is JSON, so this is a code + UI change, not a migration.
`mapLeagueRecord()` already merges field-by-field over
`DEFAULT_ROSTER_SETTINGS`, so an existing row with no `draftFormat` reads as
`hybrid` with no backfill.

**Do not derive the format from `paidAuctionSlots === 0`** — the derivation and
the stored value would drift the first time someone edits settings, and the
format gates authorization-adjacent behavior (nomination events, price writes).

Snake league settings: `budget: 0`, `paidAuctionSlots: 0`, `minimumBid: 0`,
`scoringFormat: 'ppr'`, `draftFormat: 'snake'`, starters
`[QB, RB, RB, WR, WR, TE, FLEX, K, DST]`, `benchSize: 5` → **14 rounds**.

### `player_seasons` gains parallel full-PPR columns

The two leagues need different boards for the same season: half-PPR ECR for the
hybrid league, full-PPR ECR for the snake league. `player_seasons` is unique on
`(player_id, year)`, so importing a full-PPR CSV today would overwrite the
half-PPR board.

The fields split by how format-dependent they are:

- **Format-independent** (shared, unchanged): `team`, `bye_week`, `sos`,
  `is_rookie`.
- **Format-dependent** (duplicated): `rank`, `position_rank`, `tier`,
  `ecr_vs_adp`.
- **League-dependent**: `projected_auction_value` — see below.

Migration adds nullable `rank_ppr`, `position_rank_ppr`, `tier_ppr`,
`ecr_vs_adp_ppr`. **The uniqueness key does not change**, so every existing
fetch keeps working untouched and no read can silently return two rows or the
wrong board. Only the row→player mappers (`mapSeasonToPlayer`,
`mapSeasonRecord`) pick which column set to read, from the selected league's
`scoringFormat`.

This is deliberately the untidy option, chosen over the correct one for risk
reasons stated below.

### The clean end state, and why it is not now

The right long-term shape is three tables, keyed by what the data actually
depends on:

| Table | Key | Holds |
|---|---|---|
| `player_seasons` | player + year | team, bye, SOS, rookie |
| `player_season_rankings` | player + year + format | rank, position rank, tier, ECR-vs-ADP |
| `league_player_values` | league + player + year | projected auction value |

That supports std / half / PPR with no schema change per format, and it fixes
`projected_auction_value` living on the wrong table.

It is not being done now because **it buys maintainability, not capability** —
the full-PPR board is identical either way — and it re-keys every board read
plus the value model, importer, and both CLI scripts. Slipping the draft to gain
a correct board is a good trade; slipping it to gain a tidier schema is not.

This is recorded in `ARCHITECTURE_DECISIONS.md` as an explicitly temporary shape
with the split as a named offseason follow-up, to be done before the 2027
rankings import.

### `projected_auction_value` stays put, with an invariant

It remains on `player_seasons`, valid for **at most one auction-or-hybrid league
per (year, scoring format)**. The snake league writes and reads none — no
prices, no budget, column hidden. The invariant is documented in
`ARCHITECTURE_DECISIONS.md` and lifted by the three-table split.

### ADP is derived, not stored

FantasyPros publishes `ECR VS. ADP`, already imported as `ecr_vs_adp`. The
codebase treats higher as better and notes it is "zero or negative for players
going at or above their consensus rank"
([draft-comparison.ts:34](../src/lib/draft-comparison.ts)), so the delta is
`ADP − ECR` and:

```
adp = rank + ecr_vs_adp
```

No `adp` column. One trap to design around: the importer writes `0` for a column
that is present-but-empty and leaves it untouched when absent, so a missing
delta would yield `adp === rank` silently. The derivation returns `null` when
the delta is genuinely absent rather than a plausible-looking fake.

## Isolation

The rule layer cannot do this job: a user who is a member of both leagues is
legitimately allowed to read both. Isolation is **query scoping**, with rule
tightening as defense in depth.

Every league-scoped read takes a `leagueId` and carries it in its query key:

| Query | Today | After |
|---|---|---|
| auctions list | `['auctions']`, unfiltered | `['auctions', leagueId]`, `filter: league = leagueId` |
| historical values | `['historical-values']` | `['historical-values', leagueId]` |
| computed profiles | `['computed-profiles']` | `['computed-profiles', leagueId]` |
| all fantasy teams | `['fantasy-teams']` | `['fantasy-teams', leagueId]`, `filter: league = leagueId` |

`computeHistoricalValues(leagueId)` filters official auctions on `league =
{:leagueId}`. The `imported` (`actual_auction_value`) branch is legacy and empty
(AD-13) but is a second unscoped path — scope or drop it in the same pass.

`value-data.ts` `loadFromPocketBase(pb, { leagueId })` gets the same filter,
which fixes the in-app recalculation **and** `scripts/calc-projected-values.ts`
and `scripts/backtest-value-model.ts` in one place — AD-15's "both paths price
off identical inputs" holds only if the filter is added there and nowhere else.
Both scripts gain a required `--league <id>` flag.

`resolveLeagueId()` stops guessing: the client sends the selected league id and
the action verifies membership (and commissionership for `type: 'official'`).

### External boards

External auction boards (`external: true`, no `league`) are another league's
**auction** results and are meaningless to a snake league. Include them only
when the target league's `draftFormat` is `auction` or `hybrid` **and** its
budget / paid-slot / team-count shape matches the board's.

### API rules

Bundled into the PR 2 migration:

- `fantasy_teams` list/view tighten from `@request.auth.id != ""` to
  `@request.auth.id != "" && (league.commissioner = @request.auth.id ||
  league.league_members_via_league.user ?= @request.auth.id)`. The
  authenticated wrap is mandatory — see the null-relation trap documented in
  `1784390000_authenticated_reads_only.js`.
  **The migration aborts loudly if any `fantasy_teams` row has an empty
  `league`**, rather than applying a rule that would make those rows invisible.
- `fantasy_teams` create: drop the `league = ""` escape hatch.
- `player_seasons` writes stay `@collection.leagues.commissioner ?=
  @request.auth.id`. PocketBase rules cannot tie a scoring format to the
  caller's league, so the narrowing stays in `calculateProjectedValuesCore()`
  and the import actions, which additionally assert the write's format matches
  the caller's selected league. **Accepted risk, stated plainly:** a
  commissioner of league B can, at the API level, write league A's board. Not
  new, bounded to commissioners, and not expressible in PB rules.

## League context and the landing surface

New `src/contexts/league-context.tsx`, mounted **above** `AuctionProvider` in
`app-shell.tsx` (the auctions query now depends on the selected league):

```ts
interface LeagueContextType {
  memberships: LeagueMembership[];
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
never a lazy initializer** — same hydration constraint AD-23 records for
`selected-auction-id`.

`use-league.ts` is rewritten against this provider:

- `useLeague()` reads the selected league instead of chasing
  `selectedAuction.league`. Invariant: selecting an auction also sets the league
  (`enterDraftRoom` sets both), with a dev-time assertion rather than a silent
  preference.
- `useCommissionerLeague()` → `useCommissionedLeagues()` plus
  `useIsCommissionerOf(leagueId)`.
- `useUserTeamId()` reads the membership row for the selected league.

### Landing stages

`NavigationContext` gains `landingStage: 'league' | 'draft'`.

- **0 or 1 memberships: the league stage is skipped entirely.** Existing
  single-league users and every snake-league member see no change.
- 2+ memberships and no persisted selection → `LeagueLanding`: one card per
  league (name, format badge, your team, commissioner badge, live-draft count),
  plus "Create a league" and "Join with an invite link".
- Choosing a league advances to the existing `NoActiveDraftLanding`, filtered to
  that league.
- A "switch league" control returns to the league stage and clears
  `selectedAuctionId`.

Switching leagues invalidates every league-keyed query by construction. The
per-draft state hazard AD-23 describes applies: any effect that resets on league
change must be declared **after** the effects that set derived state.

## Creating and joining leagues

**Create-league is a product capability, not a seed script.** `POST
/api/league-admin/create-league` in `pb_hooks/league_admin_routes.pb.js`
(authenticated), one transaction: create the `leagues` row with `commissioner` =
caller and validated settings; create N `fantasy_teams` bound to it; create the
caller's `league_members` row.

The UI collects league name, team count and names, scoring format, draft format,
starter positions, bench size, and (for auction/hybrid) budget, paid slots and
minimum bid — the same fields `league-view.tsx` already edits, so the creation
form mirrors them rather than inventing new ones. Validation is restated
server-side: a `snake` league must have `paidAuctionSlots: 0`; an
`auction`/`hybrid` league must have `budget >= paidAuctionSlots * minimumBid`.

**`accept-invite` is deferred.** `signupWithInvite` already handles brand-new
users joining any league, which covers all 11 snake-league members. The gap is
only an *existing* account joining a *second* league — which is the commissioner
himself, who gets his membership from league creation. Ships after the draft.

## Snake-format support

### Snake math with zero paid slots

`snake-draft.ts` treats `paidAuctionSlots <= 0` as invalid: `getSnakeRound()`
throws, `calculateCurrentSnakeTeam()` returns nulls. Change the guard to `< 0`
and let the phase offset be zero:

- `isAuctionPick(pickOrder, teamCount, 0)` → `pickOrder <= 0` → always false;
- `getSnakeRound(pickOrder, teamCount, 0)` → `Math.ceil(pickOrder / teamCount)`;
- `calculateCurrentSnakeTeam` starts the rotation at total picks 0.

`getNominatorForPick()` already returns `null` for `paidAuctionSlots <= 0`,
which is correct — there is nothing to nominate. The two PocketBase hooks must
agree:

- `draft_picks_pick_order.pb.js` — unchanged logic, but its marked snake block
  tracks the new offset;
- `auction_nomination_permissions.pb.js` — rejects nomination events outright
  for a snake-format league.

`draft-turn.golden.test.ts` executes the marked hook copies against the
TypeScript implementations; extend it with pure-snake cases so drift is a test
failure, not a live-draft authorization mismatch.

Also relax `league-view.tsx:457`'s rejection of `paidAuctionSlots <= 0` for the
snake format, and `use-auto-draft-mode.ts` (`auctionPicksTotal = 0` puts the
room in snake mode from pick 1).

### One-click drafting

**No modal during a snake draft.** The player row's action button — already
labelled `Draft` in snake mode — writes the pick directly to the team on the
clock. `canSnakeDraft` already encodes the two lanes: the commissioner can click
for whoever is up, a member only on their own turn.

No confirmation step. Mistakes go through the commissioner's corrections sheet
([pick-corrections-sheet.tsx](../src/components/pick-corrections-sheet.tsx)).

**Known limitation, documented not fixed:** `pick_order` is assigned `max + 1`
by the PocketBase hook while snake turn is derived from the pick *count*. Delete
a mid-draft pick and re-enter it and it lands at the end of the order — the
count stays right but that player shows in the wrong round. Undoing the most
recent pick is clean. Fixing the general case means renumbering, which touches
the `pick_order` hook and its unique index — load-bearing for hybrid history.

### Draft order

Set at creation via the existing drag-reorder + shuffle. A wrong order is fixed
by **deleting and recreating the draft before picks start** — free at zero
picks, no new edit UI.

### Format gating

One helper — `useDraftFormat()` off the league context — drives every gate, per
AD-23's single-predicate rule. Hidden when `format === 'snake'`:

- budget and max-bid chrome: `roster-summary.tsx`, `team-budget-pressure.tsx`,
  `team-roster-card.tsx` price lines;
- nomination: the ticker's nomination lane, `active-draft-context`'s nominated
  player, `use-auction-nomination.ts`, the nomination subscription in
  `realtime-sync.tsx`;
- price entry: `draft-confirmation-modal.tsx`'s price field,
  `editable-auction-value.tsx`, `mock-bid-actions.tsx`, watchlist
  `market_nudge`;
- price columns: Projected Price and Target Price in `players-table.tsx`,
  `player-comps-distribution.tsx`, the price sections of
  `player-history-sections.tsx` and `player-detail-modal.tsx`;
- price-shaped analysis in `analysis-view.tsx`.

### Draft-day signals

- **Derived ADP column** in the players table, sortable. ECR-vs-ADP is already a
  column ([players-table.tsx:560](../src/components/players-table.tsx)), so the
  pair costs almost nothing once the full-PPR board lands.
- **Survival to your next pick** — given the current pick and your next slot in
  the snake order, flag board and watchlist players unlikely to last. The
  highest-value snake signal; the snake-order math already exists.
- **Round · pick on the draft board** instead of price
  (`draft-pick-cell.tsx`) — without it the board reads blank for a priceless
  draft.
- Tier-cliff alerts (`draft-insights.ts`) are already format-agnostic and carry
  over unchanged.

**Deferred:** positional runs (partially redundant with survival), snake mock
drafts, derived league ADP from completed snake history.

## Imports

Rankings import gains an **explicit scoring-format picker** next to the year,
defaulting to the selected league's format and stating its destination before
confirming ("writes the full-PPR 2026 board"). With two near-identical CSVs and
two boards, inferring the target silently is a corruption waiting to happen and
the failure is invisible.

## Testing

Unit (`npm test`):

- `snake-draft.test.ts` — every function with `paidAuctionSlots: 0`.
- `draft-turn.golden.test.ts` — pure-snake cases across the TS implementation
  and both marked hook copies.
- ADP derivation, including the absent-delta → `null` case.
- Format-gating helper.

Integration (`npm run test:integration`):

- **Cross-league isolation, the headline test**: a member of both leagues
  computes history for league A and gets zero rows sourced from league B; same
  for computed profiles and the fantasy-teams list. Specifically covers the
  two-completed-official-auctions-in-one-year collapse described above.
- Rules: a commissioner of B cannot write A's `fantasy_teams`, `auctions`, or
  picks; a member of A only is invisible to B.
- The guest case re-run — `1784390000`'s null-relation trap must not reopen when
  `fantasy_teams` read rules change.
- Migration parity: empty instance from `1784300000_baseline_full.js` vs the
  incremental chain.
- `create-league` route: happy path, non-member caller, invalid settings.

## Build order — five stacked PRs

Each independently verifiable and revertible, merged as they land.

1. **League context + isolation.** `LeagueProvider`, rewritten `use-league.ts`,
   landing stage (auto-skipped at one membership), league-scoped queries and
   keys, `value-data.ts` + both scripts, `resolveLeagueId()` and
   `useCommissionerLeague()` fixes, external-board gating. Ships with the
   cross-league integration test. **No schema change.**
2. **Schema + rules migration.** Parallel PPR columns, `fantasy_teams` rule
   tightening with the abort guard, baseline reflection, format-aware mappers,
   import format picker. The one production migration wave.
3. **Create-league flow.** PB route + creation UI, per-league `league-view.tsx`,
   `draftFormat` in settings.
4. **Snake draft room.** Zero-slot snake math, hook alignment and golden tests,
   format gating, one-click drafting, round·pick board. *After this the snake
   league can run a live draft.*
5. **Survival to your next pick.**

Rules changes in PR 2 are verified with a second account against both leagues,
per AD-2's standing discipline.

## Open assumptions

- The full-PPR FantasyPros export carries an `ECR VS. ADP` column. If it does
  not, derived ADP is unavailable and PR 5 loses its input — check an export
  before starting PR 2.
- Snake-league team names are collected in the creation flow, not needed up
  front.
