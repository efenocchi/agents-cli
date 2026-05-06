#!/usr/bin/env bash
#
# Release script for agents-cli.
#
# Publishes a single version to TWO npm packages:
#   1. @phnx-labs/agents-cli  -- the canonical package (real code)
#   2. @companion/agents-cli   -- legacy shim that re-exports @phnx-labs
#
# The shim keeps existing @companion installs auto-updating into the new code.
#
# Usage: scripts/release.sh <version>     (e.g. scripts/release.sh 1.14.2)
#
# Validates that <version> is a single-step bump from the current published
# @phnx-labs latest -- patch+1, or minor+1 with patch=0, or major+1 with
# minor=patch=0. No skips.

set -euo pipefail

PHNX_PKG="@phnx-labs/agents-cli"
SWARMIFY_PKG="@companion/agents-cli"

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

red()    { printf '\033[31m%s\033[0m\n' "$*" >&2; }
green()  { printf '\033[32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[33m%s\033[0m\n' "$*"; }
gray()   { printf '\033[2m%s\033[0m\n'  "$*"; }
bold()   { printf '\033[1m%s\033[0m\n'  "$*"; }

die() { red "error: $*"; exit 1; }

# ----- Parse args -----
[[ $# -eq 1 ]] || die "usage: scripts/release.sh <version>  (e.g. 1.14.2)"
TARGET="$1"
[[ "$TARGET" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "version must be MAJOR.MINOR.PATCH (no pre-release tags)"

# ----- Pre-flight -----
command -v npm >/dev/null    || die "npm not found"
command -v node >/dev/null   || die "node not found"
command -v git >/dev/null    || die "git not found"
command -v jq >/dev/null     || die "jq not found (brew install jq)"

# Working tree must be clean
if [[ -n "$(git status --porcelain)" ]]; then
  die "working tree is dirty -- commit or stash first"
fi

# Must be on main, up to date with origin
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
[[ "$BRANCH" == "main" ]] || die "must be on main (currently on $BRANCH)"
git fetch --quiet origin main
LOCAL="$(git rev-parse HEAD)"
REMOTE="$(git rev-parse origin/main)"
[[ "$LOCAL" == "$REMOTE" ]] || die "main is not in sync with origin/main (run 'git push' first)"

# Must be logged into npm
NPM_USER="$(npm whoami 2>/dev/null || true)"
[[ -n "$NPM_USER" ]] || die "not logged into npm -- run 'npm login'"

# ----- Validate version bump -----
# Compare against current published latest of the canonical package.
PHNX_LATEST="$(npm view "$PHNX_PKG" version 2>/dev/null || true)"
[[ -n "$PHNX_LATEST" ]] || die "could not read latest version of $PHNX_PKG from npm"

SWARMIFY_LATEST="$(npm view "$SWARMIFY_PKG" version 2>/dev/null || echo "0.0.0")"

bold "Current published versions"
gray "  $PHNX_PKG       $PHNX_LATEST"
gray "  $SWARMIFY_PKG   $SWARMIFY_LATEST"
gray "  target           $TARGET"
echo

# Parse versions into M.m.p triples
parse_v() { echo "$1" | tr '.' ' '; }
read -r CMAJ CMIN CPAT <<< "$(parse_v "$PHNX_LATEST")"
read -r TMAJ TMIN TPAT <<< "$(parse_v "$TARGET")"

# Strict single-step bump from $PHNX_LATEST:
is_valid_bump=false
if [[ $TMAJ -eq $CMAJ && $TMIN -eq $CMIN && $TPAT -eq $((CPAT + 1)) ]]; then
  BUMP="patch"
  is_valid_bump=true
elif [[ $TMAJ -eq $CMAJ && $TMIN -eq $((CMIN + 1)) && $TPAT -eq 0 ]]; then
  BUMP="minor"
  is_valid_bump=true
elif [[ $TMAJ -eq $((CMAJ + 1)) && $TMIN -eq 0 && $TPAT -eq 0 ]]; then
  BUMP="major"
  is_valid_bump=true
fi

if ! $is_valid_bump; then
  red "invalid bump: $PHNX_LATEST -> $TARGET"
  red "expected one of:"
  red "  $((CMAJ)).$((CMIN)).$((CPAT + 1))   (patch)"
  red "  $((CMAJ)).$((CMIN + 1)).0   (minor)"
  red "  $((CMAJ + 1)).0.0   (major)"
  exit 1
fi

# Target must also be strictly newer than @companion latest (rare edge case).
read -r SMAJ SMIN SPAT <<< "$(parse_v "$SWARMIFY_LATEST")"
if [[ "$TMAJ$TMIN$TPAT" == "$SMAJ$SMIN$SPAT" ]] || \
   { [[ $TMAJ -lt $SMAJ ]] || \
     { [[ $TMAJ -eq $SMAJ ]] && [[ $TMIN -lt $SMIN ]]; } || \
     { [[ $TMAJ -eq $SMAJ ]] && [[ $TMIN -eq $SMIN ]] && [[ $TPAT -le $SPAT ]]; }; }; then
  die "target $TARGET is not strictly newer than @companion latest $SWARMIFY_LATEST"
fi

green "Bump: $BUMP ($PHNX_LATEST -> $TARGET)"
echo

# ----- Sync package.json with target -----
ORIGINAL_PKG_VERSION="$(jq -r .version package.json)"
PKG_BUMPED=false
restore_package_json() {
  if $PKG_BUMPED; then
    tmp="$(mktemp)"
    jq --arg v "$ORIGINAL_PKG_VERSION" '.version = $v' package.json > "$tmp"
    mv "$tmp" package.json
    yellow "Reverted package.json to $ORIGINAL_PKG_VERSION"
  fi
}
trap restore_package_json EXIT

if [[ "$ORIGINAL_PKG_VERSION" != "$TARGET" ]]; then
  yellow "Updating package.json: $ORIGINAL_PKG_VERSION -> $TARGET"
  tmp="$(mktemp)"
  jq --arg v "$TARGET" '.version = $v' package.json > "$tmp"
  mv "$tmp" package.json
  PKG_BUMPED=true
fi

# ----- Build + test -----
bold "Building..."
rm -rf dist
bun run build >/dev/null

bold "Running tests..."
npm test 2>&1 | tail -5
echo

# ----- Confirmation -----
bold "Tarball preview"
npm pack --dry-run 2>&1 | tail -10
echo

read -r -p "Publish $TARGET to BOTH $PHNX_PKG and $SWARMIFY_PKG? [y/N] " yn
[[ "$yn" =~ ^[Yy]$ ]] || die "aborted"

# Past this point we want to keep the bumped package.json, since we're
# committing it. Disable the auto-revert.
PKG_BUMPED=false

# ----- Commit + tag -----
git add package.json
if ! git diff --cached --quiet; then
  git commit -m "chore(release): $TARGET"
fi
git tag "v$TARGET"

# ----- Publish @phnx-labs -----
bold "Publishing $PHNX_PKG@$TARGET..."
read -r -p "npm OTP: " OTP_PHNX
echo
if ! npm publish --access=public --otp="$OTP_PHNX"; then
  red "publish failed for $PHNX_PKG"
  red "the version commit and tag remain locally; rerun 'npm publish --access=public --otp=...' from $ROOT to retry"
  exit 1
fi
green "Published $PHNX_PKG@$TARGET"
echo

# ----- Build and publish @companion shim -----
bold "Building $SWARMIFY_PKG@$TARGET shim..."
SHIM_SRC="$ROOT/scripts/companion-shim"
SHIM_TMP="$(mktemp -d -t agents-cli-shim)"
trap 'rm -rf "$SHIM_TMP"' EXIT

cp -R "$SHIM_SRC/bin" "$SHIM_SRC/scripts" "$SHIM_SRC/README.md" "$SHIM_TMP/"
cat > "$SHIM_TMP/package.json" <<EOF
{
  "name": "$SWARMIFY_PKG",
  "version": "$TARGET",
  "description": "This package has moved to $PHNX_PKG. Install that instead.",
  "dependencies": {
    "$PHNX_PKG": "$TARGET"
  },
  "bin": {
    "agents": "bin/agents.js",
    "ag": "bin/agents.js"
  },
  "scripts": {
    "postinstall": "node scripts/postinstall.js"
  },
  "engines": {
    "node": ">=18.0.0"
  },
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/phnx-labs/agents-cli.git"
  },
  "homepage": "https://agents-cli.sh",
  "bugs": {
    "url": "https://github.com/phnx-labs/agents-cli/issues"
  }
}
EOF

bold "Publishing $SWARMIFY_PKG@$TARGET..."
read -r -p "npm OTP (new code, OTPs are single-use): " OTP_SWARMIFY
echo
pushd "$SHIM_TMP" >/dev/null
if ! npm publish --access=public --otp="$OTP_SWARMIFY"; then
  red "publish failed for $SWARMIFY_PKG"
  red "$PHNX_PKG@$TARGET was published successfully."
  red "to retry the shim manually:"
  red "  cd $SHIM_TMP && npm publish --access=public --otp=<code>"
  popd >/dev/null
  trap - EXIT
  exit 1
fi
popd >/dev/null
green "Published $SWARMIFY_PKG@$TARGET"
echo

# ----- Push commit + tag -----
bold "Pushing commit and tag to origin..."
git push origin main
git push origin "v$TARGET"

green "Released $TARGET to both packages"
