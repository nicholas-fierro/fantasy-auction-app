# Fantasy Football Draft Helper

Draft-day command center for one 12-team half-PPR league: auction ($200 budget, 7 paid slots, $1 min bid) plus snake rounds, live multi-user draft rooms, AI mock drafts, and an auction value model trained on the league's own 2018–2025 draft history.

Next.js 15 (App Router) + React 19 on the front, PocketBase as the database and API.

## Tech stack

| Layer | Choice |
| --- | --- |
| Frontend | Next.js 15, React 19, TypeScript strict, Tailwind CSS v4 |
| UI | shadcn/ui (New York) over Radix, Lucide icons, Sonner toasts, Recharts, @dnd-kit |
| Server state | TanStack Query + PocketBase realtime (SSE) |
| Backend | PocketBase (SQLite) — collections, API rules, JS hooks, migrations |
| Tests | Vitest (unit), PocketBase integration suite, Playwright artifacts in `tests/` |
| Hosting | Vercel (Next.js) + self-hosted PocketBase |

## Architecture

**The browser talks to PocketBase directly.** There is no server-side data layer for routine reads/writes; everything goes through the SDK singleton in `src/lib/pb-client.ts` (AD-1). Consequences:

- **Authorization is PocketBase API rules, not app code** (AD-2). Per-user ownership on auctions/picks/teams/watchlist; draft-pick writes require an `active` auction. Change a rule → verify cross-user isolation with a second account.
- Record→type mapping (`src/lib/pb-mappers.ts`, `src/lib/history-client.ts`) must stay client-safe — no `next/headers`.
- TanStack Query holds all server state (AD-5); realtime SSE subscriptions patch the query cache directly (`src/components/providers/realtime-sync.tsx`, AD-4). Hooks in `src/hooks/` are the layer components consume.

**What still runs server-side** (AD-6): CSV imports (`src/server/actions/imports.ts`), auction lifecycle create/complete/delete (`auctions.ts`), invite signup (`signup.ts`), session sync (`auth.ts`). Two auth-gated API routes proxy external services: `/api/player-injuries` (Sleeper, cached) and `/api/fantasypros/compare` (rate-limited 60/hour per user).

**Auth** is client-side `authWithPassword`; a `syncSession` action mirrors the token into an httpOnly `pb_auth` cookie read by `src/middleware.ts` and the surviving server actions (AD-3). Middleware only checks cookie presence/expiry — PB rules are the real boundary. Logout and 401s must clear **both** stores.

**UI shell**: views switch through `NavigationContext` inside a single-page shell (`app-shell.tsx` / `app-content.tsx`), not routes (AD-12). Draft chrome lives in a two-tier top navbar (AD-22); the draft room keys off one `useIsDraftRoom` predicate (AD-23). Views: players, fantasy-teams, draft-board, analysis, draft-history, settings. Installable PWA with a mobile tab bar and nomination ticker.

`ARCHITECTURE_DECISIONS.md` (AD-1 … AD-27) is the decision log — read it before changing data flow, auth, or the value model.

## Data model (PocketBase collections)

- `leagues` / `league_members` / `invites` — settings + commissioner, user↔team bindings (source of "my team"), invite-only signup tokens (AD-17).
- `auctions` — `status` active|completed, `type` official|mock, `sim` for AI mocks, owned by a `user`, linked to a `league`. Picks are two-lane: owner/commissioner write any team, a member only their own (AD-18). Only official prices feed the value model.
- `players` — identity only. `gsis_id` is the canonical external join (AD-25); Sleeper/ESPN/FantasyPros IDs are provider handles. All per-year data lives in `player_seasons` (unique on player+year); season-shaped fields still on `players` are frozen legacy.
- `player_game_logs` — nflverse weekly stats + snap counts, unique per player+game. Raw scoring inputs in `stats`; scoring formats derived later.
- `draft_picks` — `auction_id`, `price`; `pick_order` assigned by a PocketBase hook, unique per auction (AD-19). Deletes cascade in PB (AD-24).
- `auction_teams` (per-auction draft order) / `fantasy_teams` (12 persistent franchises with 2018–2025 history as first-class official auctions, AD-13/14).
- `auction_nomination_events` — immutable shared event stream for official auctions (AD-20).
- `watchlist` (per user), `team_profiles` (mock-draft AI slider overrides).

SDK gotchas: parallel `create` calls to one collection need `{ requestKey: null }` (auto-cancel); transactional reorders use `pb.createBatch()` (AD-7).

## Domain logic (shared, client-side)

- `src/lib/roster.ts` — single source for roster construction, league defaults, max-bid math (AD-9). Team/role/settings come from `src/hooks/use-league.ts`.
- `src/lib/value-model.ts` + `src/lib/estimated-value.ts` — league-history value model and the shared `collectComps` behind both Projected Price and live Target Price. Two deliberate differences: Projected is budget-normalized and hides thin comp sets. Don't fork the comp logic. Methodology + backtest: [`docs/auction-value-model.md`](docs/auction-value-model.md).
- `src/lib/draft-insights.ts` — tier cliffs, pick recency, pace, budget pressure, all derived from existing queries (AD-11).
- `src/lib/mock-draft/` — pure deterministic AI draft engine (rng, profiles, pricing, nomination, auction-resolver, snake-ai); this is what the Vitest suite covers. Orchestration in `src/contexts/mock-draft-context.tsx`.
- `src/lib/fantasy-scoring.ts`, `usage-signal.ts`, `game-log-view.ts` — scoring and usage derivations over `player_game_logs`.

## Getting started

Requires Node 22.x and a local PocketBase instance.

```bash
npm install
# .env — see below
npm run dev            # Turbopack dev server at http://localhost:3000
```

PocketBase lives outside this repo (default `~/Pocketbase/main`):

```bash
cd ~/Pocketbase/main && ./pocketbase serve   # http://127.0.0.1:8090
```

Environment (`.env`, gitignored):

```
NEXT_PUBLIC_POCKETBASE_URL=http://127.0.0.1:8090   # browser
POCKETBASE_URL=http://127.0.0.1:8090               # server
FANTASYPROS_API_KEY=...                            # optional, compare panel only
PB_SUPERUSER_EMAIL=... PB_SUPERUSER_PASSWORD=...   # data scripts
```

### Migrations and hooks

Canonical copies live in `pb_migrations/` and `pb_hooks/`. To apply: copy into `~/Pocketbase/main/`, restart PocketBase (it migrates at startup and caches schema in memory). **Any schema change must also land in `pb_migrations/1784300000_baseline_full.js`** — CI diffs a baseline-built instance against the incremental chain and fails `npm run test:integration` on divergence. Production follows a separate, private migration runbook.

Hooks: server-side `pick_order` assignment, auto-complete on full rosters, shared nomination permissions, league admin routes, and login rate limiting (login is client-side, so it can't be limited in Next.js).

## Key workflows

**Pre-draft refresh** (import view, no terminal, commissioner-gated):

1. Drop the FantasyPros half-PPR cheat sheet CSV.
2. Drop the rookies CSV.
3. **Sync player IDs** — skip it and new players have no headshot, no injury badge, and a dead compare panel (AD-16).
4. **Recalculate Projected Prices** — required after every rankings import; estimates key off `rank`.

**Draft day** — create an official auction, members join the live room, nominations and picks stream over SSE. Budget guardrails reserve $1 per remaining paid slot. Completed auctions are immutable; undo removes only the most recent pick of an *active* auction, behind a confirmation (AD-10). Pick corrections go through the corrections sheet.

**Mock drafts** — a mock auction with `sim: true` whose `auction_teams` include the user's team runs the AI engine locally: nomination, bidding, and snake rounds against per-team profiles.

**CLI data jobs** — `npx tsx scripts/<name>.ts`, each documenting its flags in its header. Scripts don't load `.env` automatically: `set -a; source .env; set +a; npx tsx scripts/...`. Stats bootstrap is dry-run-first: sync IDs → repair identities → sync IDs → import game logs, reviewing every report before rerunning without `--dry-run`.

## Data dependencies

Full table with freshness and join keys: [`docs/data-sources.md`](docs/data-sources.md).

- **Live**: Sleeper injuries (proxied, cached 24h), ESPN player/team news (fetched straight from the browser), FantasyPros compare (proxied, needs an API key), ESPN/Sleeper CDN headshots (URL built client-side).
- **Copied snapshots** (do not self-update): FantasyPros rankings — the free API caps consensus rankings at 10 players, so rankings are CSV-only; nflverse weekly stats and snap counts 2018–2025; Sleeper/ESPN/FantasyPros/gsis IDs from the Sleeper dump and DynastyProcess; private league draft history imported from a normalized CSV.
- **Derived**: projected auction values (recomputed in-app or by `scripts/calc-projected-values.ts` — same model, same builders in `src/server/lib/value-data.ts`), plus everything in `draft-insights.ts` computed per render.

Game logs are QB/RB/WR/TE-complete, not roster-complete, and matched on `gsis_id` only — never on name.

## Testing

```bash
npm test                   # vitest unit suite
npm run test:watch
npm run test:integration   # spins a PocketBase instance, diffs baseline vs. migration chain
npm run build              # best full type-check
npm run lint
```

Single file: `npx vitest run src/lib/mock-draft/mock-draft.test.ts -t "name"`.

## Deployment

Vercel hosts the Next.js app. PocketBase is self-hosted behind HTTPS. Production infrastructure details and operational runbooks are kept private.

## Docs map

- `AGENTS.md` / `CLAUDE.md` — canonical reference for coding agents
- `ARCHITECTURE_DECISIONS.md` — decision log; trust it and code over other docs
- `docs/data-sources.md`, `docs/auction-value-model.md`, `docs/multi-user-plan.md`
