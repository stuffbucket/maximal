#!/usr/bin/env bash
set -euo pipefail

# Reference client entrypoint for the stuffbucket/macos-builder pipeline.
# Copy this into a client repo as .macos-builder/build.sh — the private builder
# checks the client out at the release tag and runs it from the checkout root
# (cd client && bash .macos-builder/build.sh) on the self-hosted macOS runner.
#
# It builds + signs + notarizes + staples the macOS Tauri .dmg, then drops the
# .dmg and its .sha256 into $OUTPUT_DIR for the builder to upload to the release.
#
# Signing is inside-out: the Bun sidecar is signed BEFORE `tauri build` bundles
# it (so the inner binary carries its own Developer ID + hardened runtime
# signature), then the .app is signed WITHOUT --deep (deprecated; it skips
# Contents/Resources and would overwrite the sidecar's entitlements).
# Notarizing the .dmg notarizes the .app + sidecar nested inside it.
#
# Env supplied by the builder (consumed below):
#   TAG, ARCH, OUTPUT_DIR, SIGN_IDENTITY, APPLE_ID, APPLE_PASSWORD,
#   APPLE_TEAM_ID, BUN_INSTALL, CARGO_HOME
# The signing keychain is ALREADY unlocked by the builder — do NOT unlock it
# here, and this script never reads KEYCHAIN_PASSWORD.

# Self-hosted runners use non-login shells that don't read ~/.zshrc — make bun
# and cargo discoverable for every step below.
export PATH="$BUN_INSTALL/bin:$CARGO_HOME/bin:$PATH"

VERSION="${TAG#v}"
DMG="maximal-${TAG}-darwin-${ARCH}.dmg"
APP="shell/src-tauri/target/release/bundle/macos/Maximal.app"
ENTITLEMENTS="build/macos/maximal.entitlements"

echo "Building maximal ${TAG} (version ${VERSION}, ${ARCH}) -> ${DMG}"

# Tauri reads its version from tauri.conf.json, not git tags. Stamp it.
/usr/bin/sed -i '' -e "s/\"version\": \"0\\.0\\.0\"/\"version\": \"${VERSION}\"/" \
  shell/src-tauri/tauri.conf.json
grep '"version"' shell/src-tauri/tauri.conf.json

# Install JS deps (root + shell).
bun install
bun install --cwd shell

# Build the Bun-compiled proxy sidecar.
MAXIMAL_FORCE_SIDECAR="1" bun run app:sidecar
ls -la shell/src-tauri/binaries/

# Pre-sign the Bun sidecar BEFORE `tauri build` bundles it. Bun stamps a
# linker-only signature the notary rejects — strip it, then sign with a
# Developer ID + hardened runtime and the same entitlements the app uses (JIT /
# unsigned executable memory / library validation, which the Bun runtime needs).
shopt -s nullglob
signed=0
for SIDECAR in shell/src-tauri/binaries/maximal-*; do
  [ -f "$SIDECAR" ] || continue
  echo "Pre-signing sidecar: $SIDECAR"
  codesign --remove-signature "$SIDECAR" 2>/dev/null || true
  codesign --force --options runtime --timestamp \
    --identifier co.stuffbucket.maximal.proxy \
    --entitlements "$ENTITLEMENTS" \
    --sign "$SIGN_IDENTITY" \
    "$SIDECAR"
  codesign --verify --strict --verbose=2 "$SIDECAR"
  codesign -dvv "$SIDECAR" 2>&1 | grep -E 'flags=|Authority=' || true
  signed=$((signed + 1))
done
if [ "$signed" -eq 0 ]; then
  echo "::error::No sidecar binary found under shell/src-tauri/binaries/maximal-*"
  exit 1
fi

# Build the .app via Tauri.
(
  cd shell
  bun run tauri build --bundles app
  ls -la src-tauri/target/release/bundle/macos/
)

# Sign the bundle WITHOUT --deep. The sidecar inside is already signed; signing
# the bundle top-level seals it without re-signing nested code. (--verify --deep
# only inspects nested signatures, it doesn't replace them.)
codesign --force --options runtime --timestamp \
  --identifier co.stuffbucket.maximal \
  --entitlements "$ENTITLEMENTS" \
  --sign "$SIGN_IDENTITY" \
  "$APP"
codesign --verify --deep --strict --verbose=2 "$APP"

# Stage the DMG layout (.app + drag-to-Applications symlink).
STAGE="$(mktemp -d)/dmg-stage"
mkdir -p "$STAGE"
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"

# Build + sign the DMG.
mkdir -p dist-release
OUT="dist-release/${DMG}"
hdiutil create \
  -volname "Maximal" \
  -srcfolder "$STAGE" \
  -ov -format UDZO \
  "$OUT"
codesign --force --sign "$SIGN_IDENTITY" "$OUT"
codesign --verify --verbose=2 "$OUT"

# Notarize + staple the .dmg (which notarizes the .app + sidecar inside it). On
# a rejection, fetch the notary log (it names the exact offending binary) before
# failing — this runner is the only place signing happens, so logs matter.
set +e
SUBOUT="$(xcrun notarytool submit "$OUT" \
  --apple-id "$APPLE_ID" --password "$APPLE_PASSWORD" \
  --team-id "$APPLE_TEAM_ID" --wait --output-format json)"
RC=$?
set -e
echo "$SUBOUT"
STATUS="$(echo "$SUBOUT" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("status",""))' 2>/dev/null || echo '')"
if [ "$RC" -ne 0 ] || [ "$STATUS" != "Accepted" ]; then
  UUID="$(echo "$SUBOUT" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("id",""))' 2>/dev/null || echo '')"
  if [ -n "$UUID" ]; then
    echo "::group::notarytool log $UUID"
    xcrun notarytool log "$UUID" \
      --apple-id "$APPLE_ID" --password "$APPLE_PASSWORD" \
      --team-id "$APPLE_TEAM_ID" || true
    echo "::endgroup::"
  fi
  echo "::error::DMG notarization failed (status='${STATUS}')."
  exit 1
fi
xcrun stapler staple "$OUT"
xcrun stapler validate "$OUT"
spctl -a -t open --context context:primary-signature -v "$OUT"
(cd dist-release && shasum -a 256 "${DMG}" > "${DMG}.sha256")

# Hand the signed/stapled artifacts to the builder via OUTPUT_DIR.
mkdir -p "$OUTPUT_DIR"
cp "$OUT" "$OUT.sha256" "$OUTPUT_DIR/"
echo "Landed in ${OUTPUT_DIR}:"
ls -la "$OUTPUT_DIR/${DMG}" "$OUTPUT_DIR/${DMG}.sha256"
