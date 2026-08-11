---
name: apply-migration
description: Apply a PocketBase migration to the production Oracle VM over Tailscale SSH, from writing the file through backup, restart, and verification.
---

# Applying a PocketBase migration to production

Production is a PocketBase instance on an Oracle Always-Free Ampere VM, reached
over Tailscale. Migrations are plain JS files that PocketBase applies **at
startup** — "running a migration" means staging the file and restarting the
service.

`docs/runbooks/upgrade.md` covers *binary* upgrades and its paths are stale
(`/opt/pocketbase`). The paths below are the real ones, read from the systemd
unit on 2026-07-25.

## The box

| | |
|---|---|
| SSH | `ssh fantasy-auction-app` (Tailscale), lands as `ubuntu@fantasy-auction-app` |
| PB home | `/opt/fantasy-auction-app/pocketbase` — binary, `pb_data/`, `pb_migrations/`, `pb_hooks/` |
| Repo checkout | `/opt/fantasy-auction-app/app-repo` — **the public repo**, canonical since the cutover |
| Legacy checkout | `/opt/fantasy-auction-app/repo` — pre-cutover, still tracks `…-private`. Stale; do not pull from it |
| Service | `fantasy-auction-app.service`, `User=Group=pocketbase` |
| Backups | `/opt/backups/pocketbase/` |
| Public | https://fantasy-auction-app.duckdns.org (PB listens on `127.0.0.1:8090` behind a proxy) |

`ExecStart` passes no `--dir`/`--migrationsDir`, so PocketBase uses the
directories next to its binary. `/opt/fantasy-auction-app/pocketbase` is
mode-restricted — `ubuntu` needs `sudo` even to `ls` it.

## Before you SSH: write and prove the migration locally

1. Canonical copy goes in this repo's `pb_migrations/`, named
   `<epoch>_<snake_case>.js`, higher than every existing timestamp. Give it a
   working `down` even though rollback is done from a backup.
2. **If it changes schema, update `pb_migrations/1784300000_baseline_full.js`
   to match.** CI boots two instances — one with only the baseline, one with
   every other migration — and asserts identical schemas
   (`scripts/run-pocketbase-integration.sh`). Forget this and
   `tests/integration/pocketbase.integration.test.ts` fails on a field-level
   diff. Find the field in the baseline JSON and edit the value in place.
3. `npm run test:integration` — must be green before it goes anywhere near
   production. It downloads its own pinned PocketBase, no local server needed.
4. Try it on the local instance too: copy into `~/Pocketbase/main/pb_migrations/`
   and restart `./pocketbase serve`.
5. Push the branch. The VM pulls from git; nothing is scp'd by hand.

### Which repo — check this first

Two GitHub repos and two checkouts on the box, and they do not agree:

| | |
|---|---|
| `nicholas-fierro/fantasy-auction-app` | **public, canonical since the cutover.** Deployed from. Cloned on the VM at `/opt/fantasy-auction-app/app-repo` |
| `nicholas-fierro/fantasy-auction-app-private` | pre-cutover source, kept private. Cloned at `/opt/fantasy-auction-app/repo`, which is now stale (8+ commits behind its own origin, and missing everything merged publicly) |

Confirm before you pull:

```bash
sudo git -C /opt/fantasy-auction-app/app-repo remote get-url origin
```

If your migration is merged to the public repo, `app-repo` is the only checkout
that will ever see it. Pulling `repo` gets you pre-cutover code.

Verified 2026-08-10: every path in "The box" above is correct as written.

## On the VM

```bash
ssh fantasy-auction-app
```

### 1. Get the migration into the checkout

```bash
cd /opt/fantasy-auction-app/app-repo
git branch --show-current
git fetch origin main && git checkout main && git pull
ls pb_migrations/ | tail -3
```

The public repo is HTTPS and needs no deploy key. If for some reason the
checkout cannot be updated, fetching the single file is still git-traceable —
verify the checksum against your local copy before staging it:

```bash
curl -fsS -o /tmp/<file>.js https://raw.githubusercontent.com/nicholas-fierro/fantasy-auction-app/main/pb_migrations/<file>.js
sha256sum /tmp/<file>.js   # must match `shasum -a 256` on your machine
```

Never `sudo git` here. `sudo` resets `SSH_AUTH_SOCK` and reads root's
`~/.ssh/config`, so the `github-fantasy-auction-app` host alias and the deploy
key both disappear. The checkout is owned by `ubuntu` for exactly this reason.

### 2. Pre-flight anything that adds a UNIQUE index

Migrations run at boot, and an index whose existing rows violate it **aborts
the boot** — not just the migration. Skip this only if the migration adds no
unique index.

```bash
sudo sqlite3 /opt/fantasy-auction-app/pocketbase/pb_data/data.db "SELECT file FROM _migrations ORDER BY file;" | tail -5
```

Anything absent will run on the next restart. For each unapplied index-adding
migration, count violating rows with the index's own columns and WHERE clause,
e.g. for `idx_auctions_active_user_type`:

```bash
sudo sqlite3 /opt/fantasy-auction-app/pocketbase/pb_data/data.db "SELECT user, type, count(*) c FROM auctions WHERE status='active' AND user!='' GROUP BY user, type HAVING c>1;"
```

Zero rows means it will build cleanly. Resolve any it returns first.

### 3. Stop and back up

Production goes down here. Everything through step 5 is one continuous stretch —
don't wander off mid-way.

```bash
sudo systemctl stop fantasy-auction-app.service
```

```bash
PB=/opt/fantasy-auction-app/pocketbase; TS=$(TZ=America/New_York date +%Y%m%d_%H%M%S); B=/opt/backups/pocketbase/pre-migration-${TS}; sudo mkdir -p "$B" && sudo cp -a "$PB/pb_data" "$PB/pb_migrations" "$B/" && echo "backup: $B"
```

### 4. Stage the file

```bash
sudo install -o pocketbase -g pocketbase -m 644 /opt/fantasy-auction-app/app-repo/pb_migrations/<file>.js /opt/fantasy-auction-app/pocketbase/pb_migrations/
```

Ownership matters — the service runs as `pocketbase` and won't read a
root-owned drop-in.

### 5. Start; the restart is what applies it

```bash
sudo systemctl start fantasy-auction-app.service && sleep 3 && systemctl is-active fantasy-auction-app.service
```

```bash
sudo journalctl -u fantasy-auction-app.service --since "2 minutes ago" --no-pager | tail -20
```

Want the migration filename and no `error`/`panic`.

**Do not run `pocketbase migrate up` by hand.** `ExecStart` carries
`--encryptionEnv=PB_ENCRYPTION_KEY`; settings are encrypted with a key systemd
supplies from an environment file, and a hand-run binary won't have it. Let
systemd start the process.

**Do not `systemctl daemon-reload` as part of this.** The on-disk unit has
drifted from the loaded one (as of 2026-07-25), so a reload would swap in an
unreviewed change mid-maintenance. Deal with the drift separately, deliberately:
`systemctl cat fantasy-auction-app.service` shows what's on disk.

### 6. Verify

```bash
curl -fsS https://fantasy-auction-app.duckdns.org/api/health
```

```bash
sudo sqlite3 /opt/fantasy-auction-app/pocketbase/pb_data/data.db "SELECT file FROM _migrations ORDER BY file;" | tail -3
```

Then assert the actual change. Collection schema lives as JSON in
`_collections.fields`, so query it rather than trusting the migration ran:

```bash
sudo sqlite3 /opt/fantasy-auction-app/pocketbase/pb_data/data.db "SELECT json_extract(value,'\$.name'), json_extract(value,'\$.cascadeDelete') FROM _collections, json_each(_collections.fields) WHERE name='draft_picks' AND json_extract(value,'\$.type')='relation';"
```

Finish with the app-level behavior the migration was for — exercise it in the
UI, don't just trust the schema.

### 7. Rollback

Restore the backup. The migration's `down` needs a running PocketBase to
execute, which is the thing that may be broken.

```bash
PB=/opt/fantasy-auction-app/pocketbase; B=$(ls -td /opt/backups/pocketbase/pre-migration-* | head -1); sudo systemctl stop fantasy-auction-app.service; sudo rm -rf "$PB/pb_data" "$PB/pb_migrations" && sudo cp -a "$B/pb_data" "$B/pb_migrations" "$PB/" && sudo chown -R pocketbase:pocketbase "$PB/pb_data" "$PB/pb_migrations" && sudo systemctl start fantasy-auction-app.service && echo "rolled back from $B"
```

## Ordering against the app deploy

A schema migration and the app code that depends on it rarely land together.
Ask which direction is safe *before* sequencing:

- Migration first is safe when old code still works against the new schema
  (adding a column, widening a constraint, enabling a cascade the old code
  duplicates by hand).
- App first is safe when the new code doesn't require the schema change yet.
- If neither holds, take the downtime rather than guessing.

## Verifying an API-rule migration

Schema you can read out of `_collections`; authorization you cannot — a rule is
only correct relative to who is asking. Check it from outside, unauthenticated,
against the real host:

```bash
for c in auctions draft_picks auction_teams leagues league_members invites; do
  printf "%-16s " "$c"
  curl -s "https://fantasy-auction-app.duckdns.org/api/collections/$c/records?perPage=1&fields=id" \
    | python3 -c "import sys,json;d=json.load(sys.stdin);print('LEAK total='+str(d['totalItems']) if d.get('totalItems') else 'ok')"
done
```

**A rule comparing a field to `@request.auth.id` does not imply
authentication.** A guest carries auth.id `""`, and an empty relation resolves
to null, which PocketBase compares EQUAL to `""`. So
`league.commissioner = @request.auth.id` is true for an anonymous caller on
every record whose `league` is unset. This was live in production and exposed
8 auctions, 1,524 picks, and 96 auction_teams rows — the pre-league-model rows
all carry an empty `league`. Fixed by 1784380000 and 1784390000, which wrap the
affected read rules in `@request.auth.id != "" && (…)`.

Any new rule that leans on a relation needs that guard. Assert it in
`tests/integration/pocketbase.integration.test.ts` — both the rule string and a
guest read — or the next one lands the same way.

## Gotchas

- Migrations apply **only at startup**. A file sitting in `pb_migrations/`
  changes nothing until the service restarts.
- PocketBase caches schema in memory — the same restart requirement applies to
  the local dev instance at `~/Pocketbase/main`.
- `pb_hooks/` follows the identical workflow: canonical copies in this repo,
  copy in, restart.
- Hand-editing collections in the PB admin UI puts production out of sync with
  `pb_migrations/`, and the next `test:integration` run will catch it as a
  baseline mismatch. Change schema through migrations only.
