#!/usr/bin/env bash
#
# Install this working tree as the global `agents` (and `ag`) binary.
#
# Usage: scripts/install.sh [<version>] [--skip-build] [--skip-tests]
#
#   <version>      optional, e.g. 1.15.0 or 1.15.0-alpha.9 -- writes to package.json
#   --skip-build   reuse existing dist/ instead of rebuilding
#   --skip-tests   skip the test suite (forwarded to build)

set -euo pipefail

cd "$(dirname "$0")/.."

dim()    { printf '\033[2m%s\033[0m\n'  "$*"; }
green()  { printf '\033[32m%s\033[0m\n' "$*"; }
red()    { printf '\033[31m%s\033[0m\n' "$*" >&2; }
bold()   { printf '\033[1m%s\033[0m'    "$*"; }

die() { red "  Error: $*"; exit 1; }

SKIP_BUILD=false
SKIP_TESTS=false
VERSION=""
SEMVER_RE='^[0-9]+\.[0-9]+\.[0-9]+(-(alpha|beta)\.[0-9]+)?$'
for arg in "$@"; do
  case "$arg" in
    --skip-build) SKIP_BUILD=true ;;
    --skip-tests) SKIP_TESTS=true ;;
    -h|--help)
      sed -n '3,9p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    --*) die "unknown flag: $arg" ;;
    *)
      [[ -z "$VERSION" ]] || die "unexpected argument: $arg"
      [[ "$arg" =~ $SEMVER_RE ]] || die "invalid version '$arg' (expected MAJOR.MINOR.PATCH or MAJOR.MINOR.PATCH-(alpha|beta).N)"
      VERSION="$arg"
      ;;
  esac
done

command -v npm >/dev/null || die "npm not found"

if [[ -n "$VERSION" ]] && $SKIP_BUILD; then
  node -e "const fs=require('fs'),p='./package.json',j=JSON.parse(fs.readFileSync(p));j.version='$VERSION';fs.writeFileSync(p,JSON.stringify(j,null,2)+'\n')"
fi

PKG_NAME=$(node -p "require('./package.json').name")
PKG_VER="${VERSION:-$(node -p "require('./package.json').version")}"

bold "Install"; echo "  $PKG_NAME@$PKG_VER (local)"
echo

if ! $SKIP_BUILD; then
  BUILD_ARGS=()
  [[ -n "$VERSION" ]] && BUILD_ARGS+=("$VERSION")
  $SKIP_TESTS && BUILD_ARGS+=(--skip-tests)
  ./scripts/build.sh "${BUILD_ARGS[@]}"
  echo
fi

[[ -f dist/index.js ]] || die "dist/index.js missing -- run scripts/build.sh first"

dim "  Linking globally via npm"
npm install -g . --silent --no-fund --no-audit >/dev/null

LINKED_PATH=$(command -v agents 2>/dev/null || true)
[[ -n "$LINKED_PATH" ]] || die "'agents' not on PATH after install"

LINKED_VER=$(agents --version 2>/dev/null | head -1 || echo "?")

green "  Ready"
dim   "  agents -> $LINKED_PATH"
dim   "  version $LINKED_VER"
