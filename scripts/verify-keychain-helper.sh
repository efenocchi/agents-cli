#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

expected="$(cut -d ' ' -f 1 scripts/AgentsKeychain.app.sha256)"
actual="$(shasum -a 256 bin/AgentsKeychain.app/Contents/MacOS/AgentsKeychain | cut -d ' ' -f 1)"

if [ "$actual" != "$expected" ]; then
  echo "AgentsKeychain.app SHA256 mismatch" >&2
  echo "expected: $expected" >&2
  echo "actual:   $actual" >&2
  exit 1
fi
