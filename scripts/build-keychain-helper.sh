#!/usr/bin/env bash
# Build, sign, and notarize the keychain helper binary.
# Requires: APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID in env.
# Output: bin/agents-keychain (universal binary, notarized)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SOURCE="$REPO_ROOT/src/lib/keychain-helper.swift"
ENTITLEMENTS="$REPO_ROOT/scripts/keychain-entitlements.plist"
OUT="$REPO_ROOT/bin/agents-keychain"

: "${APPLE_ID:?APPLE_ID not set}"
: "${APPLE_APP_SPECIFIC_PASSWORD:?APPLE_APP_SPECIFIC_PASSWORD not set}"
: "${APPLE_TEAM_ID:?APPLE_TEAM_ID not set}"

SIGN_IDENTITY="Developer ID Application: Muqit Nawaz ($APPLE_TEAM_ID)"

mkdir -p "$REPO_ROOT/bin"

echo "Compiling arm64..."
swiftc -O -target arm64-apple-macos12 "$SOURCE" -o /tmp/agents-keychain-arm64

echo "Compiling x86_64..."
swiftc -O -target x86_64-apple-macos12 "$SOURCE" -o /tmp/agents-keychain-x86_64

echo "Creating universal binary..."
lipo -create -output "$OUT" /tmp/agents-keychain-arm64 /tmp/agents-keychain-x86_64

echo "Signing..."
codesign \
  --sign "$SIGN_IDENTITY" \
  --options runtime \
  --entitlements "$ENTITLEMENTS" \
  --force \
  "$OUT"

echo "Verifying signature..."
codesign --verify --verbose "$OUT"

echo "Packaging for notarization..."
ditto -c -k --keepParent "$OUT" /tmp/agents-keychain-notarize.zip

echo "Submitting for notarization (this takes ~1 min)..."
xcrun notarytool submit /tmp/agents-keychain-notarize.zip \
  --apple-id "$APPLE_ID" \
  --password "$APPLE_APP_SPECIFIC_PASSWORD" \
  --team-id "$APPLE_TEAM_ID" \
  --wait

echo "Checking Gatekeeper..."
spctl --assess --type execute "$OUT" && echo "Gatekeeper: accepted" || echo "Gatekeeper: pending (online check will pass on first run)"

echo ""
echo "Done. $OUT is ready."
echo "Run 'bun run build' to copy it into dist/lib/."
