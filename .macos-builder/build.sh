#!/usr/bin/env bash
set -euo pipefail

# Maximal's PRODUCER for the stuffbucket/macos-builder pipeline.
#
# Builds the signed Electron client (client/) into an .app and leaves it at the
# config's `app_path`:
#   client/out/Maximal-darwin-arm64/Maximal.app
#
# It does NOT build a dmg/pkg, notarize, staple, or write OUTPUT_DIR — the builder
# owns that tail (lib/package-macos.sh: top-level sign without --deep → package →
# notarize → staple → checksum). The producer is never handed APPLE_* or
# KEYCHAIN_PASSWORD.
#
# Unlike a Tauri app (one main binary + sidecar), an Electron .app contains nested
# Helper apps + the Electron Framework, which MUST be signed inside-out. The
# builder's later top-level sign alone cannot do that, so this producer performs
# the full inside-out sign here via @electron/osx-sign (driven by electron-forge
# `package`, gated on SIGN_IDENTITY in forge.config.ts). The builder's top-level
# re-sign then just re-seals the outer bundle (no --deep, idempotent). We also
# PRE-sign the Bun sidecar before packaging (belt-and-suspenders: a Bun-compiled
# binary ships only a linker ad-hoc signature the notary rejects; pre-signing with
# the runner's Developer ID guarantees it's correct regardless of whether
# osx-sign re-walks it).
#
# Builder-supplied env consumed: TAG, ARCH, SIGN_IDENTITY, ENTITLEMENTS_DIR,
# BUN_INSTALL, CARGO_HOME. The keychain is already unlocked — do not unlock it.

# Self-hosted runners use non-login shells that don't read ~/.zshrc. Include
# Homebrew's bin (/opt/homebrew/bin) — the runner's non-login PATH omits it, and
# it's where node/npm live if brew-installed (build.yml prepends it the same way).
export PATH="$BUN_INSTALL/bin:$CARGO_HOME/bin:/opt/homebrew/bin:$PATH"

# electron-forge (used below) does NOT support bun as a package manager — it
# requires npm/yarn/pnpm on PATH even when we run everything else through bun
# (its "Checking your system" preflight runs `npm --version`). Fail loudly and
# early with a diagnosis if none is present, rather than deep inside forge.
if ! command -v npm >/dev/null 2>&1 && ! command -v pnpm >/dev/null 2>&1 && ! command -v yarn >/dev/null 2>&1; then
  echo "::group::Node package-manager diagnosis (none found on PATH)"
  echo "PATH=$PATH"
  command -v node npm pnpm yarn bun 2>&1 || true
  ls -la /opt/homebrew/bin/node /opt/homebrew/bin/npm 2>&1 || true
  ls -d "$HOME"/.nvm/versions/node/* 2>/dev/null || true
  echo "::endgroup::"
  echo "::error::electron-forge needs npm/yarn/pnpm on PATH (bun is unsupported by forge). Install Node on the builder runner (e.g. brew install node)." >&2
  exit 1
fi
echo "Package manager for forge: $(command -v npm || command -v pnpm || command -v yarn)"

VERSION="${TAG#v}"
ARCH="${ARCH:-arm64}"
APP="client/out/Maximal-darwin-${ARCH}/Maximal.app"
# Builder-owned, enumerated entitlements (config: `entitlements = bun-runtime`).
# forge.config.ts reads MACOS_ENTITLEMENTS to sign every Electron component +
# the sidecar with this same profile.
ENTITLEMENTS="$ENTITLEMENTS_DIR/bun-runtime.entitlements"
export MACOS_ENTITLEMENTS="$ENTITLEMENTS"

echo "Producing Maximal.app (Electron) for ${TAG} (version ${VERSION}, ${ARCH})"

cd client

# electron-forge / @electron/packager read the app version from package.json.
# Stamp the tag version, matching WHATEVER value is there (not just "0.0.0") so a
# stray committed value can't slip through unstamped, then ASSERT the stamp took.
/usr/bin/sed -i '' -E "s/\"version\": \"[^\"]*\"/\"version\": \"${VERSION}\"/" package.json
grep '"version"' package.json | head -1
if ! grep -q "\"version\": \"${VERSION}\"" package.json; then
  echo "::error::Failed to stamp version ${VERSION} into client/package.json" >&2
  exit 1
fi

# Install deps (brings @stuffbucket/maximal-core into node_modules for --compile).
bun install

# Build the Bun-compiled maximal-core sidecar into resources/bin/maximal-core;
# forge copies it into the app via extraResource.
bun run build:core
CORE="resources/bin/maximal-core"
if [ ! -s "$CORE" ]; then
  echo "::error::Sidecar not produced at client/${CORE}" >&2
  exit 1
fi
chmod 0755 "$CORE"
ls -la resources/bin/

# Pre-sign the Bun sidecar (strip its linker ad-hoc signature, then sign with
# Developer ID + hardened runtime + the bun-runtime entitlements the Bun runtime
# needs: JIT / unsigned-executable-memory / library-validation). osx-sign may
# re-sign it during packaging with the same profile — either way it ends up
# correct. The builder's later top-level sign is WITHOUT --deep, so it won't
# clobber the inner signatures.
codesign --remove-signature "$CORE" 2>/dev/null || true
codesign --force --options runtime --timestamp \
  --identifier co.stuffbucket.maximal.proxy \
  --entitlements "$ENTITLEMENTS" \
  --sign "$SIGN_IDENTITY" \
  "$CORE"
codesign --verify --strict --verbose=2 "$CORE"

# Self-hosted runner: out/ persists across builds. Nuke it so every build
# regenerates the bundle from the freshly-stamped version (no stale Info.plist).
rm -rf out

# Build + inside-out sign ONLY the .app (no dmg — the builder packages +
# notarizes). Signing is enabled because SIGN_IDENTITY + MACOS_ENTITLEMENTS are
# exported (see forge.config.ts). --arch is pinned so the output dir name matches
# the config's app_path.
bun run package -- --arch="${ARCH}"

cd ..
ls -la "$(dirname "$APP")"

# ---------------------------------------------------------------------------
# Assert the built bundle before handing it to the builder.
# ---------------------------------------------------------------------------
[ -d "$APP" ] || { echo "::error::Expected app not found at ${APP}" >&2; exit 1; }

# Bundle id must equal the approved builder policy's bundle_id_allowed.
BUILT_ID="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' \
  "${APP}/Contents/Info.plist" 2>/dev/null || echo '')"
echo "Bundle id: ${BUILT_ID}"
if [ "${BUILT_ID}" != "co.stuffbucket.maximal" ]; then
  echo "::error::CFBundleIdentifier '${BUILT_ID}' != co.stuffbucket.maximal (policy gate would reject)." >&2
  exit 1
fi

# Version must match the tag (catches a stale/cached bundle).
BUILT_VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' \
  "${APP}/Contents/Info.plist" 2>/dev/null || echo '')"
echo "Built bundle version: ${BUILT_VERSION} (expected ${VERSION})"
if [ "${BUILT_VERSION}" != "${VERSION}" ]; then
  echo "::error::Bundle version '${BUILT_VERSION}' != release version '${VERSION}'. Stale build?" >&2
  exit 1
fi

# The sidecar must be present inside the bundle and validly signed.
BUNDLED_CORE="${APP}/Contents/Resources/bin/maximal-core"
[ -f "$BUNDLED_CORE" ] || { echo "::error::Sidecar missing from bundle: ${BUNDLED_CORE}" >&2; exit 1; }
codesign --verify --strict --verbose=2 "$BUNDLED_CORE"

# Full inside-out verification: helpers + Electron Framework + sidecar + app must
# all be correctly signed. (Under a real Developer ID this passes; under a bare
# unsigned dev build it will not — signing is builder-only.)
codesign --verify --deep --strict --verbose=2 "$APP"
codesign -dvv "$APP" 2>&1 | grep -E 'Identifier=|Authority=|flags=' || true

echo "Producer done — ${APP} is ready for the builder (top-level sign + dmg + notarize + staple + sha256)."
