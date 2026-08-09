# Data Sources

Every piece of data the app shows, where it comes from, and how it gets stale.

Four classifications:

- **Live** — fetched from an external service at request time. Never stored in PocketBase. Freshness is a cache TTL.
- **Copied** — pulled from an external source once by a script or an import, then stored in PocketBase. Stale until someone re-runs the import.
- **Derived** — computed from other data in this table. Some derivations are stored (offline scripts), some are recomputed in the browser on every render.
- **Entered** — created by users inside the app. This league is the source of truth; nothing external to sync.

---

## Live

| Data | Source | Path | Freshness | Notes |
| --- | --- | --- | --- | --- |
| Injury status | Sleeper `/v1/players/nfl` | [route.ts](../src/app/api/player-injuries/route.ts) → [use-player-injuries.ts](../src/hooks/use-player-injuries.ts) | server `unstable_cache` 24h; browser `Cache-Control` 1h; TanStack `staleTime` 1h | Auth-gated proxy (`requireAuth`). Raw dump exceeds Next's data-cache entry limit, so it's reduced to an injury-only map before caching. Sleeper asks for ≤1 fetch/day. Joined on `players.sleeper_id` — players without one show no badge. |
| Player news | ESPN athlete overview + team news | [espn-news.ts](../src/lib/espn-news.ts) → [use-player-news.ts](../src/hooks/use-player-news.ts) | `staleTime` 15min | Fetched **directly from the browser**, no proxy, no API key. Falls back to team-scoped news when `players.espn_id` is null. |
| Expert rank comparison | FantasyPros `/compare-players` | [fantasypros.ts](../src/server/lib/fantasypros.ts) → [/api/fantasypros/compare](../src/app/api/fantasypros/compare/route.ts) | `next.revalidate` 30min | Needs `FANTASYPROS_API_KEY`. Rate-limited 60/hour per user to protect the upstream quota. Joined on `players.fantasypros_id`. |
| Headshots / team logos | ESPN combiner CDN, Sleeper CDN | [player-images.ts](../src/lib/player-images.ts) | CDN | URL is built client-side from `espn_id` → `sleeper_id` → team logo (DST) → null. No fetch by us. |

**FantasyPros rankings are NOT available live.** The public API caps `consensus-rankings` at 10 players on the free tier (`public_api_limited: true`, `limit: 10`, against a `count` of 675). Same reason [sync-fantasypros-ids.ts](../scripts/sync-fantasypros-ids.ts) sources IDs from DynastyProcess instead. Rankings are Copied — see below.

---

## Copied

Everything here is a snapshot. It does not update itself.

| Data | Fields | Source → mechanism | Cadence |
| --- | --- | --- | --- |
| Current rankings | `player_seasons`: `rank`, `tier`, `position_rank`, `team`, `bye_week`, `sos`, `ecr_vs_adp` | FantasyPros half-PPR cheat sheet CSV export → drag-drop [import-view.tsx](../src/components/import-view.tsx) → `importRankingsCore` | Manual, before each draft |
| Historical rankings 2019–2024 | same | Wayback snapshots → [import-wayback-rankings.mjs](../scripts/import-wayback-rankings.mjs) → `data/historical-rankings/fp-half-ppr-<year>.csv` → [run-historical-import.ts](../scripts/run-historical-import.ts) | One-shot, done |
| 2025 rankings | same | Hand-entered into PocketBase | One-shot, done |
| Rookie flags | `player_seasons.is_rookie` | Rookie CSV → `importRookiesCore` | With each rankings refresh |
| Draft history 2018–2025, auction phase | `auctions` (official) + `draft_picks` where `price > 0` | League draft workbook → normalized per-pick CSV → private one-time importer | One-shot, done |
| Draft history 2018–2025, snake rounds | `draft_picks` where `price = 0` | Physical draft-board photos → private per-year CSV → PocketBase | One-shot, done |
| Sleeper / ESPN IDs | `players.sleeper_id`, `players.espn_id` | Sleeper player dump + DynastyProcess `db_playerids.csv` → **"Sync player IDs"** button, or [sync-player-images.ts](../scripts/sync-player-images.ts) | After any import that creates new players |
| FantasyPros IDs | `players.fantasypros_id` | DynastyProcess `db_fpecr_latest.csv` → **"Sync player IDs"** button, or [sync-fantasypros-ids.ts](../scripts/sync-fantasypros-ids.ts) | After any import that creates new players |
| gsis IDs | `players.gsis_id` | DynastyProcess `db_playerids.csv` → [sync-player-ids.ts](../scripts/sync-player-ids.ts) | CLI only — the in-app button does not fill this one |
| Weekly player stats 2018–2025 | `player_game_logs`: `season`, `week`, `season_type`, `game_id`, `team`, `opponent`, `stats` | nflverse `stats_player_week_<year>.csv` → [import-nflverse-player-game-logs.ts](../scripts/import-nflverse-player-game-logs.ts) | Per season, after the season ends |
| Snap counts 2018–2025 | `player_game_logs.stats`: `offense_snaps`, `offense_pct`, `st_snaps`, `st_pct` | nflverse `snap_counts_<year>.csv` → [import-nflverse-snap-counts.ts](../scripts/import-nflverse-snap-counts.ts) | Per season, after the weekly stats for that season |
| Birth dates | `players.birth_date` | nflverse `roster_<year>.csv`, topped up from DynastyProcess → same snap-count script | Backfilled with each snap import; never overwritten |

The league's own draft history and its one-time import tooling are private and
are not published in this repository.

Matching logic for the sleeper/espn/fantasypros IDs lives in [player-ids.ts](../src/server/lib/player-ids.ts), shared by the button and both scripts, so they map players identically.

**Game logs are QB/RB/WR/TE-complete, not roster-complete.** Weekly stats are matched only on `gsis_id`, never on name. Snap counts key on `pfr_player_id`, which this app does not store — the map is rebuilt per run from `roster_<year>.csv` and topped up from DynastyProcess (~99.7% of skill snap rows resolve). Snap rows with offensive snaps but no weekly-stats row are *created* with zeroed scoring stats; a player who was on the field and produced nothing is real data, and it is precisely what touch-based features cannot see. Both importers merge into `stats` rather than replacing it, so running them in either order does not drop the other's keys.

### Refresh order before a draft

All in the import view, no terminal required:

1. Export the FantasyPros half-PPR cheat sheet as CSV, drop it on the Import view.
2. Rookies CSV, same place.
3. **Sync player IDs** — fills `sleeper_id` / `espn_id` / `fantasypros_id` for the players step 1 just created. Skip it and rookies have no headshot, no injury badge, and a dead compare panel.
4. **Recalculate Projected Prices** — see Derived. Required after every rankings import, since estimates key off `rank`.

Steps 3 and 4 are commissioner-only. The CLI equivalents still exist and produce identical results — `sync-player-images.ts`, `sync-fantasypros-ids.ts`, `calc-projected-values.ts` — and are the better choice for dry runs (`--dry-run`) or when you want the full ambiguous/unmatched tables. Scripts need env: `set -a; source .env; set +a; npx tsx scripts/<name>.ts`.

---

## Derived

### Stored (computed offline, written to PocketBase)

| Data | Field | Computed by | Rule |
| --- | --- | --- | --- |
| Projected auction value | `player_seasons.projected_auction_value` | [value-model.ts](../src/lib/value-model.ts), inputs assembled by [value-data.ts](../src/server/lib/value-data.ts). Triggered by the in-app "Recalculate Projected Prices" button or [calc-projected-values.ts](../scripts/calc-projected-values.ts) | Recency-weighted comps over this league's own official auction history, normalized to the $2400 budget. Methodology: [auction-value-model.md](auction-value-model.md). **Must be re-run after every rankings import** — it keys off `rank`. |

Both triggers run the same model over the same builders, so they produce identical numbers. Only rows whose value changed are written.

Historical note: that button used to apply a linear rank→price curve and clobber the model's output, which is what AD-15 warned against. It no longer does.

### Recomputed in the browser (nothing stored)

| Data | Module | Inputs |
| --- | --- | --- |
| Target price (live market read) | [estimated-value.ts](../src/lib/estimated-value.ts) | Historical prices, memoized per position |
| Historical values table | [history-client.ts](../src/lib/history-client.ts) | PB reads + in-memory joins; client port of the old server `computeHistoricalValues` |
| Tier cliffs, pick recency, pace, budget pressure | [draft-insights.ts](../src/lib/draft-insights.ts) | Existing queries only, no extra collections (AD-11) |
| Best value / biggest reach | [draft-highlights.ts](../src/lib/draft-highlights.ts) | Picks vs projected values |
| Roster construction, max bid | [roster.ts](../src/lib/roster.ts) | Picks + league settings (AD-9) |
| Whose turn it is | [draft-turn.ts](../src/lib/draft-turn.ts), [snake-draft.ts](../src/lib/snake-draft.ts) | `auction_teams.draft_order` + picks |
| Active nomination | [active-nomination.ts](../src/lib/active-nomination.ts) | `auction_nomination_events`, ordered by server-assigned `event_order` |
| Expert-consensus verdict | [draft-comparison.ts](../src/lib/draft-comparison.ts) | Live FantasyPros ballots + local `ecr_vs_adp`, `tier`, projected value |
| Mock draft board | [src/lib/mock-draft/](../src/lib/mock-draft/) | Pure deterministic engine — seeded RNG, team profiles, rankings, projected values |
| Player detail merge | [player-detail.ts](../src/lib/player-detail.ts) | Historical rows joined to current players |

---

## Entered

League-authored, no external source, no sync.

| Collection | What |
| --- | --- |
| `auctions` | Draft sessions — `status` active/completed, `type` official/mock, `sim` for AI mocks |
| `draft_picks` | Picks and prices. `pick_order` assigned server-side by a PocketBase hook, unique per auction (AD-19) |
| `auction_teams` | Per-auction draft order |
| `fantasy_teams` | The 12 persistent franchises |
| `leagues` | Commissioner + `settings` JSON (budget, paid slots, min bid) |
| `league_members` | user ↔ team binding; source of "my team" |
| `invites` | Invite-only signup tokens |
| `watchlist` | Per-user player watchlist |
| `team_profiles` | Persisted mock-draft AI slider overrides |
| `users` | Accounts (PocketBase auth collection) |

---

## Frozen legacy

Season-shaped fields still present on `players` (`rank`, `tier`, `position_rank`, `bye_week`, `sos`, `ecr_vs_adp`, `projected_auction_value`, `actual_auction_value`) plus `fantasy_teams.draft_order` and `fantasy_teams.actual_auction_value`. All per-year data moved to `player_seasons`. Don't read them; don't write them.

---

## Failure modes worth knowing

- **New players show no injury badge or headshot, or the compare panel says "needs a FantasyPros ID mapping."** They have no provider IDs yet. Press **Sync player IDs**.
- **Prices look wrong after a rankings import.** `projected_auction_value` is stale until **Recalculate Projected Prices** runs.
- **ESPN news fails silently for some players.** No `espn_id` → team-scoped news; no team match → the query is disabled.
- **Copying records between local and production fails with `validation_missing_rel_records`.** PocketBase ids are per-instance — the same player, team and auction have different ids on each. Resolve by natural key instead: auction by `year` + `type`, team by `name`, player by `gsis_id`. Player *names* are not a safe key across instances.
- **A partial rankings CSV no longer blanks `sos` / `ecr_vs_adp`.** [`rankingFields`](../src/server/lib/import-core.ts) writes only the columns the CSV actually has; it used to write `0` for absent ones, silently wiping both fields on every existing row. A present-but-empty cell still writes 0, which is a real value.
