#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
version=0.29.1
platform=""
archive_checksum=""
binary_checksum=""

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64)
    platform=linux_amd64
    archive_checksum=8ba9edc571485b3deac7bbd33ec5de84967d3806964ba2daba17e1a1de42105b
    binary_checksum=f8b4a869344de28f02528306298428435e2ca05ddbb474cc3325470b2841a490
    ;;
  Darwin-arm64)
    platform=darwin_arm64
    archive_checksum=b098b586dd7b5427822d9a547add7448ced901236a5e1c0f32fd2b1535cfd7dc
    binary_checksum=93e18c85a559fa190027437157dc47199852bdc4a83bc4e3e10406682f0f2942
    ;;
  Darwin-x86_64)
    platform=darwin_amd64
    archive_checksum=9fa5d7ebb40f56b4127b4ec5ad7818d7cb832c9af96a07a0fe600414ae967705
    binary_checksum=4580f022e33fecd3b6ca8f806e99d4d2aa5aec3b5c9cb7bcb75dadffaec72d37
    ;;
  *)
    echo "Unsupported PocketBase integration platform: $(uname -s)-$(uname -m)" >&2
    exit 1
    ;;
esac

sha256() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    sha256sum "$1" | awk '{print $1}'
  fi
}

cache_dir=${POCKETBASE_CACHE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/fantasy-auction-app/pocketbase/$version/$platform}
archive="$cache_dir/pocketbase_${version}_${platform}.zip"
binary="$cache_dir/pocketbase"
mkdir -p "$cache_dir"

if [ ! -f "$archive" ]; then
  curl -fsSL "https://github.com/pocketbase/pocketbase/releases/download/v${version}/pocketbase_${version}_${platform}.zip" -o "$archive"
fi
if [ "$(sha256 "$archive")" != "$archive_checksum" ]; then
  rm -f "$archive"
  echo "PocketBase archive checksum mismatch for $platform" >&2
  exit 1
fi

if [ ! -f "$binary" ] || [ "$(sha256 "$binary")" != "$binary_checksum" ]; then
  rm -f "$binary"
  unzip -q -o "$archive" pocketbase -d "$cache_dir"
  chmod +x "$binary"
fi
"$repo_root/scripts/verify-pocketbase.sh" "$binary" "$binary_checksum"
"$binary" --version | grep -F "$version" >/dev/null

scratch=$(mktemp -d "${TMPDIR:-/tmp}/fantasy-auction-pb-integration.XXXXXX")
baseline_pid=""
incremental_pid=""
cleanup() {
  status=$?
  trap - EXIT INT TERM
  [ -z "$baseline_pid" ] || kill "$baseline_pid" 2>/dev/null || true
  [ -z "$incremental_pid" ] || kill "$incremental_pid" 2>/dev/null || true
  [ -z "$baseline_pid" ] || wait "$baseline_pid" 2>/dev/null || true
  [ -z "$incremental_pid" ] || wait "$incremental_pid" 2>/dev/null || true
  rm -rf "$scratch"
  exit "$status"
}
trap cleanup EXIT INT TERM

baseline_root="$scratch/baseline"
incremental_root="$scratch/incremental"
for root in "$baseline_root" "$incremental_root"; do
  mkdir -p "$root/pb_data" "$root/pb_migrations" "$root/pb_hooks"
  cp "$repo_root"/pb_hooks/*.pb.js "$root/pb_hooks/"
done
cp "$repo_root/pb_migrations/1784300000_baseline_full.js" "$baseline_root/pb_migrations/"
node "$repo_root/tests/integration/create-legacy-migration.mjs" \
  "$repo_root/pb_migrations/1784300000_baseline_full.js" \
  "$incremental_root/pb_migrations/1783000000_legacy_schema.js"
for migration in "$repo_root"/pb_migrations/*.js; do
  [ "$(basename "$migration")" = "1784300000_baseline_full.js" ] || cp "$migration" "$incremental_root/pb_migrations/"
done

baseline_port=${PB_BASELINE_PORT:-8091}
incremental_port=${PB_INTEGRATION_PORT:-8092}
if [ "$baseline_port" = 8090 ] || [ "$incremental_port" = 8090 ] || [ "$baseline_port" = "$incremental_port" ]; then
  echo "Integration ports must be distinct and must not use the development port 8090" >&2
  exit 1
fi

admin_email="integration-admin-$(node -e "process.stdout.write(require('node:crypto').randomUUID())")@example.test"
# hex, not base64url: a base64url password can start with '-', which cobra parses as a
# flag in `superuser upsert EMAIL PASSWORD` — it errors "unknown shorthand flag" yet
# exits 0, so set -e passes, the superuser is never created, and tests 400 on auth
# (~1.5% of runs). hex (0-9a-f) never leads with '-'. Same 192-bit entropy.
admin_password=$(node -e "process.stdout.write(require('node:crypto').randomBytes(24).toString('hex'))")

provision_superuser() {
  root=$1
  "$binary" superuser upsert "$admin_email" "$admin_password" \
    --automigrate=false \
    --dir "$root/pb_data" \
    --migrationsDir "$root/pb_migrations" \
    --hooksDir "$root/pb_hooks" >/dev/null
}
provision_superuser "$baseline_root"
provision_superuser "$incremental_root"

assert_port_available() {
  node -e "const p=Number(process.argv[1]);const s=require('node:net').createServer();s.once('error',()=>process.exit(1));s.listen(p,'127.0.0.1',()=>s.close())" "$1" || {
    echo "PocketBase integration port $1 is already in use; override PB_BASELINE_PORT/PB_INTEGRATION_PORT" >&2
    exit 1
  }
}
assert_port_available "$baseline_port"
assert_port_available "$incremental_port"

baseline_log="$scratch/baseline.log"
incremental_log="$scratch/incremental.log"
"$binary" serve \
  --dir "$baseline_root/pb_data" \
  --migrationsDir "$baseline_root/pb_migrations" \
  --hooksDir "$baseline_root/pb_hooks" \
  --hooksWatch=false \
  --http "127.0.0.1:$baseline_port" >"$baseline_log" 2>&1 &
baseline_pid=$!
"$binary" serve \
  --dir "$incremental_root/pb_data" \
  --migrationsDir "$incremental_root/pb_migrations" \
  --hooksDir "$incremental_root/pb_hooks" \
  --hooksWatch=false \
  --http "127.0.0.1:$incremental_port" >"$incremental_log" 2>&1 &
incremental_pid=$!

wait_ready() {
  url=$1
  pid=$2
  log=$3
  attempts=0
  until curl -fsS "$url/api/health" >/dev/null 2>&1; do
    attempts=$((attempts + 1))
    if ! kill -0 "$pid" 2>/dev/null || [ "$attempts" -ge 300 ]; then
      echo "PocketBase failed to become ready at $url" >&2
      grep -n . "$log" >&2 || true
      return 1
    fi
    sleep 0.1
  done
}
wait_ready "http://127.0.0.1:$baseline_port" "$baseline_pid" "$baseline_log"
wait_ready "http://127.0.0.1:$incremental_port" "$incremental_pid" "$incremental_log"

check_hook_logs() {
  log=$1
  if grep -Eiq 'failed to (load|register).*hook|hook.*(syntax|reference).*error|error.*pb_hooks' "$log"; then
    echo "PocketBase hook load error in $log" >&2
    grep -Ein 'failed to (load|register).*hook|hook.*(syntax|reference).*error|error.*pb_hooks' "$log" >&2
    return 1
  fi
}
check_hook_logs "$baseline_log"
check_hook_logs "$incremental_log"

export PB_BASELINE_URL="http://127.0.0.1:$baseline_port"
export PB_INTEGRATION_URL="http://127.0.0.1:$incremental_port"
export PB_INTEGRATION_ADMIN_EMAIL="$admin_email"
export PB_INTEGRATION_ADMIN_PASSWORD="$admin_password"
export PB_INTEGRATION_LOGS="$baseline_log:$incremental_log"

cd "$repo_root"
npx vitest run --config vitest.integration.config.ts "$@"
check_hook_logs "$baseline_log"
check_hook_logs "$incremental_log"
