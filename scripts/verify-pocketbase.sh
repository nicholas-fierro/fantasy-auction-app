#!/bin/sh
# verify-pocketbase.sh - validate PocketBase binary version and checksum
# Usage: verify-pocketbase.sh <binary-path> [expected-checksum]
#
# Runs <binary-path> --version and verifies its SHA-256 checksum.
# Expected checksum comes from env var POCKETBASE_CHECKSUM or the second argument.
# On mismatch or error, exits 1.
#
# chmod +x scripts/verify-pocketbase.sh before use.

set -e

if [ $# -lt 1 ]; then
  echo "Usage: verify-pocketbase.sh <binary-path> [expected-checksum]" >&2
  exit 1
fi

pb_binary="$1"
expected_checksum="${2:-$POCKETBASE_CHECKSUM}"

# Verify binary exists
if [ ! -f "$pb_binary" ]; then
  echo "Error: PocketBase binary not found at $pb_binary" >&2
  exit 1
fi

# Print version
echo "PocketBase version:"
"$pb_binary" --version || { echo "Error: failed to run PocketBase --version" >&2; exit 1; }
echo

# Compute checksum (handle both macOS shasum and Linux sha256sum)
if command -v shasum >/dev/null 2>&1; then
  computed_checksum=$(shasum -a 256 "$pb_binary" | awk '{print $1}')
elif command -v sha256sum >/dev/null 2>&1; then
  computed_checksum=$(sha256sum "$pb_binary" | awk '{print $1}')
else
  echo "Error: neither shasum nor sha256sum found" >&2
  exit 1
fi

echo "Computed SHA-256: $computed_checksum"

# Verify against expected checksum if provided
if [ -n "$expected_checksum" ]; then
  if [ "$computed_checksum" = "$expected_checksum" ]; then
    echo "Checksum verified."
    exit 0
  else
    echo "Error: checksum mismatch" >&2
    echo "  Expected: $expected_checksum" >&2
    echo "  Got:      $computed_checksum" >&2
    exit 1
  fi
else
  echo "Warning: no expected checksum provided; computed checksum above is for reference" >&2
  exit 0
fi
