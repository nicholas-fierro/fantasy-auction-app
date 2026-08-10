# Canonical Reference for Agents working in this codebase

This file provides guidance to coding agents when working with code in this repository.

## Rules of Operation

- Always run on caveman ultra mode
- Always run on ponytail ultra mode

## Commands

- `npm run dev` — dev server with Turbopack at http://localhost:3000
- `npm run build` — production build (also the best full type-check)
- `npm run lint` — ESLint
- `npm test` — vitest run (unit tests, node environment, `src/**/*.test.ts`)
- `npm run test:watch` — vitest watch mode
- Single test file: `npx vitest run src/lib/mock-draft/mock-draft.test.ts` (add `-t "name"` for one test)
- Data scripts run with `npx tsx scripts/<name>.ts` (tsx is fetched on demand; each script documents its flags in its header). `calc-projected-values.ts` and `backtest-value-model.ts` accept `--data <dump.json>` for credential-less offline runs.
- Player stats bootstrap is dry-run-first: sync IDs, repair reviewed identities, sync IDs again, then import game logs. Review every report before rerunning without `--dry-run`.

### PocketBase (required for the app to run)

The backend is a locally run PocketBase instance at `http://127.0.0.1:8090` (lives at `~/Pocketbase/main`, started with `./pocketbase serve`). URLs come from `NEXT_PUBLIC_POCKETBASE_URL` (browser) and `POCKETBASE_URL` (server), both falling back to the localhost default.

**Migrations:** canonical copies live in this repo's `pb_migrations/`. To apply one, copy it into `~/Pocketbase/main/pb_migrations/` and restart PocketBase (it applies migrations at startup and caches schema in memory). A schema-changing migration must also be reflected in `pb_migrations/1784300000_baseline_full.js` — CI compares an empty instance built from that baseline against one built from the incremental chain, and a divergence fails `npm run test:integration`. Production migrations follow a separate, privately documented runbook.

**Hooks:** canonical copies live in this repo's `pb_hooks/` — same workflow (copy into `~/Pocketbase/main/pb_hooks/`, restart). Hooks: server-side `pick_order` assignment on draft-pick creates (AD-19), shared nomination permissions (AD-20), and login rate limiting (`users_login_rate_limit.pb.js` — 10 attempts/15min per IP and per email; enforced in PB because login is client-side authWithPassword and can't be limited in Next.js, #36).

## Architecture

Fantasy football draft helper: Next.js 15 App Router + React 19 frontend, PocketBase as the database/API. League context: 12 teams, half PPR, auction ($200 for 7 paid slots) and snake formats.

**`ARCHITECTURE_DECISIONS.md` is the decision log (AD-1 … AD-19) — consult it before changing data flow, auth, or the value model.** Deeper design docs are in `docs/` (multi-user model: `docs/multi-user-plan.md`).

### Data flow: browser → PocketBase directly

There is no server-side data layer for routine reads/writes. The browser talks straight to PocketBase through the SDK singleton in `src/lib/pb-client.ts` (AD-1). Consequences:

- **Authorization is PocketBase API rules**, not app code (AD-2, migration `1784100000_api_rules_lockdown.js`). Per-user ownership on auctions/draft_picks/auction_teams/watchlist; draft-pick writes require the auction be `active`. If you change rules, verify cross-user isolation with a second account.
- Record→type mapping lives in `src/lib/pb-mappers.ts` and `src/lib/history-client.ts` and **must stay client-safe** (no `next/headers` etc.).
- TanStack Query holds all server state; query keys and returned shapes are frozen from the server-action era (AD-5). Realtime SSE subscriptions (`src/components/providers/realtime-sync.tsx`) patch the query cache directly (AD-4).
- Hooks in `src/hooks/` are the query/mutation layer components consume.

What still runs server-side (AD-6): CSV imports (`src/server/actions/imports.ts` + `src/server/lib/import-core.ts`), auction lifecycle create/complete/delete (`src/server/actions/auctions.ts`), and session sync (`auth.ts`). Two API routes proxy external services, both requiring auth (`requireAuth`): `/api/player-injuries` (Sleeper, reduced + cached server-side; auth added per #36) and `/api/fantasypros/compare` (FantasyPros comparison, rate-limited 60/hour per user → 429 to protect the upstream quota). Application rate limits use the shared in-memory limiter `src/server/lib/rate-limit.ts` (fixed-window, per-instance — see its `ponytail:` note): signup 10/15min per IP and invite preview 30/15min per IP (`signup.ts`), plus the FantasyPros per-user limit. Login is limited in PocketBase, not here (see Hooks).

### Auth

Login is client-side (`authWithPassword` → SDK localStorage authStore); a `syncSession` server action mirrors the token into an httpOnly `pb_auth` cookie that `src/middleware.ts` and the surviving server actions read (AD-3). The middleware only checks cookie presence/expiry for login redirects — PB rules are the real boundary. Logout/401 handling must clear **both** stores.

### Data model (PocketBase collections)

- `leagues` / `league_members` / `invites` — multi-user model (AD-17): league settings + commissioner, user↔team bindings (source of "my team"), and invite-only signup tokens (`signupWithInvite` server action + `/signup`).
- `auctions` — multi-auction: `status` active|completed, `type` official|mock, `sim` (AI mock draft), owned by `user`, linked to a `league`. League members read official auctions; picks are two-lane (AD-18): owner/commissioner write any team, a member only their own. Only official auction prices feed historical value estimates.
- `players` — identity only (name, position). PocketBase `id` remains the app relation key; `gsis_id` is the canonical external football-data join, with FantasyPros/Sleeper/ESPN IDs retained as provider handles. All per-year data is in `player_seasons` (unique on player_id+year); the displayed season is the selected auction's year. Season-shaped fields still on `players` (and `fantasy_teams.draft_order`, `actual_auction_value`) are frozen legacy — don't read them.
- `player_game_logs` — imported nflverse weekly player stats, unique by player+game. Authenticated clients may read; only a superuser importer writes. Store raw scoring inputs in `stats` and derive scoring formats later; do not fetch game logs from FantasyPros in the browser (AD-25).
- `draft_picks` — has `auction_id` and `price`; `pick_order` is assigned server-side by a PocketBase hook, unique per auction (AD-19, supersedes AD-8).
- `auction_teams` — per-auction draft order; `fantasy_teams` are the 12 persistent franchises with full 2018–2025 pick history imported as first-class official auctions (AD-13/14).
- `watchlist` — per user; `team_profiles` — persisted mock-draft AI slider overrides.

PB SDK gotchas: the SDK auto-cancels concurrent identical requests — parallel `create` calls to one collection need `{ requestKey: null }`. Transactional multi-record reorders use `pb.createBatch()` (batch API enabled by migration, AD-7).

### Domain logic (shared, client-side)

- `src/lib/roster.ts` — single source for roster construction, default league settings ($200 budget, 7 paid slots, $1 min bid), and max-bid math (AD-9). The user's team, live league settings, and pick-entry role come from `src/hooks/use-league.ts` (`useUserTeamId` / `useLeague` / `useDraftRole`) — the old `USER_TEAM_ID` constant is gone (AD-17).
- `src/lib/draft-insights.ts` — tier-cliff alerts derived from existing queries, with no extra collections (AD-11).
- `src/lib/mock-draft/` — pure, deterministic AI draft engine (rng, profiles, pricing, nomination, auction-resolver, snake-ai, engine); this is what the vitest suite covers. Orchestration in `src/contexts/mock-draft-context.tsx`, UI in `src/components/mock-draft/`. The sim only activates for a non-read-only mock auction with `sim: true` whose `auction_teams` include the user's team.
- `src/lib/value-model.ts` — league-history value model, and the single `collectComps` shared with the live "Target Price" estimator (`src/lib/estimated-value.ts`). Two differences remain between Projected Price and Target Price, both deliberate: Projected is normalized to the league budget, and Projected publishes nothing below `minComps` comps while Target shows any non-empty comp set (so a thin neighborhood yields a Target Price with no Projected Price). Everything else — windows, decay, the cross-position gate — is shared; don't fork the comp logic again. `projected_auction_value`s are recomputed either in-app ("Recalculate Projected Prices" in the import view, commissioner-gated) or by `scripts/calc-projected-values.ts`; both run the same model over the same `src/server/lib/value-data.ts` builders, so they agree by construction. Rerun after every rankings import — estimates key off `rank`. Methodology + backtest: `docs/auction-value-model.md` (AD-15).
- **External auction boards.** `scripts/import-external-auction.ts` loads another league's completed auction (same 12-team / $200 / 7-paid-slot shape) as comp material from a JSON board in `data/external-auctions/`. It writes an `official` auction flagged `external` (migration `1784380000_external_auction_reads.js`), which is the marker everything keys on. Read access is granted to any authenticated user on both the auction and its picks — deliberately on `list` as well as `view`, since `getFullList` is governed by the list rule, so the CLI and the in-app "Recalculate Projected Prices" button price off identical inputs and cannot disagree. Writes stay superuser-only. The flag also keeps these out of the league: `auction-context` filters them from the auctions list so one is never selectable or enterable, `history-client.ts` excludes them from the one-auction-per-year collapse, and `mock-draft-data.ts` skips their team-less picks when building manager profiles while keeping them as comps and excluding their years from `completedYears`. The importer validates every column against the budget before writing — a column over budget is a transcription error and aborts.
  External rows are the **only** ones admitted from the draft year itself (our own auction for the year being priced has not happened, and a live one must never price the draft it is running). They are discounted by `ValueModelConfig.externalWeight`, default 0.5, which puts them at ~11% of a typical target's comp weight; `--external-weight 0` reproduces a run that never saw them. That number is a stated prior, not a fitted one — there is one external board and no holdout year containing one.

- `src/server/lib/player-ids.ts` — matches players to `sleeper_id` / `espn_id` / `fantasypros_id`, shared by the in-app "Sync player IDs" action and the two CLI sync scripts. Run it after a rankings import or new players have no headshot, no injury badge, and a dead compare panel (AD-16).

### UI structure

Views are switched by `NavigationContext` (`src/contexts/navigation-context.tsx`) inside a single-page shell (`src/components/app-shell.tsx` / `app-content.tsx`), not by routes — the players view is the default signed-in landing (AD-12 superseded by PR #100). Components are shadcn/ui (New York style) over Radix; `@/` maps to `src/`. UI primitive files are intentionally pruned to live exports; re-add missing primitives from upstream shadcn rather than assuming each file contains the full generated component. Charts use the position-color convention in `analysis-view.tsx`, not shadcn `--chart-*` tokens.

## Test credentials (local dev only)

Create a dedicated local app user and PocketBase superuser. Keep emails,
passwords, and record IDs only in gitignored `.env`; never write them into
tracked files. Next.js loads `.env` automatically, but standalone scripts do
not — source it first: `set -a; source .env; set +a; npx tsx scripts/<name>.ts`.

Use an empty test account rather than owner data, and clean up test rows when
done.

## Notes

- trust `ARCHITECTURE_DECISIONS.md` and the code over it where they disagree.
- Completed auctions are immutable; undo only removes the most recent pick of an *active* auction, behind a confirmation (AD-10).
