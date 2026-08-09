---
name: verify
description: Build, launch, and drive this app to verify changes end-to-end.
---

# Verifying fantasy-auction-app

## Prerequisites
- PocketBase must be running: `cd ~/Pocketbase/main && ./pocketbase serve` (serves http://127.0.0.1:8090; the app's server actions default to this URL). Health check: `curl http://127.0.0.1:8090/api/health`.
- PB collections have open API rules — REST reads/writes need no auth. Schema changes go in `~/Pocketbase/main/pb_migrations/*.js` (auto-applied at startup; canonical copies live in this repo's `pb_migrations/`). The running server caches schema — restart it after adding a migration.
- Inspect data directly: `sqlite3 -readonly ~/Pocketbase/main/pb_data/data.db`.

## Launch
- `npm run dev` (background), wait for 200 from http://localhost:3000.
- The UI is fully client-rendered (TanStack Query) — curl only gets loading shells. Drive it with a real browser.

## Drive (no Playwright in repo)
- `npm install playwright --no-save` in a scratch dir, then `chromium.launch({ channel: 'chrome' })` — uses installed system Chrome, no browser download.
- Navigation is state-based, not routes: click sidebar buttons by title (`button[title="Players"]`, `"Fantasy Teams"`, `"Draft Board"`).
- Auction switcher is the top bar's `button[role="combobox"]`; options via `getByRole('option')`.
- Drafted rows are `table tbody tr td.line-through` (class on the `<td>`, not a descendant).
- Auction draft flow: click a row's last-column button (nominates) → banner input `input[type=number]` → check button → confirmation dialog → combobox → option → "Draft Player".
- Snake drafting only unlocks after 84 picks exist in the auction (auction phase comes first) — the action button is correctly disabled before that.

## Gotchas
- Test data cleanup: deleting an auction cascades its `draft_picks` and `auction_teams` (AD-24), so drop the auction and the rest goes with it. Don't delete picks by hand first — their delete rule requires an *active* auction, so that fails on anything completed. Reactivate the real auction with a PATCH to `status: "active"`.
- PB JS SDK auto-cancels concurrent identical requests — parallel `create` calls to one collection need `{ requestKey: null }`.
