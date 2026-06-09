#!/usr/bin/env bash
set -euo pipefail

# Maximal's PRODUCER for the stuffbucket/macos-builder pipeline (refreshed
# contract). Its ONLY job is to build the unsigned Maximal.app and leave it at
# the config's `app_path`:
#   shell/src-tauri/target/release/bundle/macos/Maximal.app
#
# It does NOT top-level-sign the app, build a dmg/pkg, notarize, staple, or
# write OUTPUT_DIR — the builder owns that entire tail (lib/package-macos.sh:
# top-level sign without --deep → package → notarize → staple → checksum). The
# producer is never handed APPLE_* or KEYCHAIN_PASSWORD.
#
# The one bit of signing here is inside-out PRE-signing of the Bun sidecar
# before `tauri build` bundles it: a Bun-compiled binary ships only a linker
# ad-hoc signature the notary rejects, and signing needs the runner's keychain
# + identity (SIGN_IDENTITY), which only exist on the builder. The builder's
# later top-level sign uses no --deep, so it won't clobber the inner signature.
#
# Builder-supplied env consumed: TAG, ARCH, SIGN_IDENTITY, ENTITLEMENTS_DIR,
# BUN_INSTALL, CARGO_HOME. The keychain is already unlocked — do not unlock it.

# Self-hosted runners use non-login shells that don't read ~/.zshrc.
export PATH="$BUN_INSTALL/bin:$CARGO_HOME/bin:$PATH"

VERSION="${TAG#v}"
APP="shell/src-tauri/target/release/bundle/macos/Maximal.app"
# Builder-owned, enumerated entitlements (config: `entitlements = bun-runtime`).
ENTITLEMENTS="$ENTITLEMENTS_DIR/bun-runtime.entitlements"

echo "Producing Maximal.app for ${TAG} (version ${VERSION}, ${ARCH})"

# Tauri reads its version from tauri.conf.json, not git tags. Stamp it. Match
# WHATEVER version is there (not just the "0.0.0" placeholder) so a stray
# committed value can't slip through unstamped, then ASSERT the stamp took — a
# silent sed no-op would ship the wrong CFBundleShortVersionString.
/usr/bin/sed -i '' -E "s/\"version\": \"[^\"]*\"/\"version\": \"${VERSION}\"/" \
  shell/src-tauri/tauri.conf.json
grep '"version"' shell/src-tauri/tauri.conf.json
if ! grep -q "\"version\": \"${VERSION}\"" shell/src-tauri/tauri.conf.json; then
  echo "::error::Failed to stamp version ${VERSION} into tauri.conf.json" >&2
  exit 1
fi

# Install JS deps (root + shell).
bun install
bun install --cwd shell

# Build the Bun-compiled proxy sidecar.
MAXIMAL_FORCE_SIDECAR="1" bun run app:sidecar
ls -la shell/src-tauri/binaries/

# Pre-sign the Bun sidecar BEFORE `tauri build` bundles it. Strip Bun's
# linker-only signature, then sign with Developer ID + hardened runtime + the
# bun-runtime entitlements (JIT / unsigned-executable-memory / library-
# validation, which the Bun runtime needs). The builder's later top-level sign
# is WITHOUT --deep, so it won't clobber this inner signature.
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

# Self-hosted runner: target/ persists across builds, and `tauri build` doesn't
# always regenerate the bundle's Info.plist — a stale Maximal.app from a prior
# tag can survive with the WRONG version. Nuke the bundle output so every build
# regenerates it from the freshly-stamped version.
rm -rf shell/src-tauri/target/release/bundle

# Build ONLY the .app via Tauri (no dmg — the builder packages + notarizes).
(
  cd shell
  bun run tauri build --bundles app
  ls -la src-tauri/target/release/bundle/macos/
)

# Proactive guard: the built bundle's version MUST match the tag. Catches a
# stale/cached Info.plist (the "0.4.14 in a 0.4.20 dmg" class) at build time
# instead of in a user's About box.
BUILT_VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' \
  "${APP}/Contents/Info.plist" 2>/dev/null || echo '')"
echo "Built bundle version: ${BUILT_VERSION} (expected ${VERSION})"
if [ "${BUILT_VERSION}" != "${VERSION}" ]; then
  echo "::error::Bundle version '${BUILT_VERSION}' != release version '${VERSION}'. Stale build artifact?" >&2
  exit 1
fi

# Done — Maximal.app is at the config's app_path. The builder takes it from
# here (top-level sign + dmg + notarize + staple + sha256).
