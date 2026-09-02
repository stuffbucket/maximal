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
# THIS SCRIPT DOES NOT SIGN, and must not learn how. The builder runs it with the
# signing keychain LOCKED and SIGN_IDENTITY set to the ad-hoc identity "-", so a
# packager configured to sign fails with "No identity found for signing". That
# failure is the point: untrusted client code can never reach the Developer ID.
#
# An Electron .app nests four Helper apps and the Electron Framework, and a
# bundle must be signed as a DIRECTORY so the seal covers its Info.plist and
# structure. `sign_walk = bun-runtime` in .macos-builder/config asks the builder
# to sign every nested code item deepest-first, then seal the outer bundle.
#
# Builder-supplied env consumed: TAG, ARCH, BUN_INSTALL, CARGO_HOME.
# SIGN_IDENTITY and ENTITLEMENTS_DIR are also exported and deliberately UNUSED.

# Self-hosted runners use non-login shells that don't read ~/.zshrc.
#
# /opt/homebrew/bin is APPENDED, never prepended. Prepending it put Homebrew's
# node ahead of the pinned Node the builder installs with actions/setup-node, so
# the release was built on whatever major Homebrew happened to carry.
export PATH="$BUN_INSTALL/bin:$CARGO_HOME/bin:$PATH:/opt/homebrew/bin"

VERSION="${TAG#v}"
ARCH="${ARCH:-arm64}"
APP="client/out/Maximal-darwin-${ARCH}/Maximal.app"
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

# Electron Forge/Vite is a Node/npm toolchain. Keep Bun scoped to compiling the
# maximal-core sidecar; using Bun as npm/Node here triggers Forge's package-manager
# preflight and CommonJS interop failures in plugin-vite.
npm ci

# Build the Bun-compiled maximal-core sidecar into resources/bin/maximal-core;
# forge copies it into the app via extraResource.
npm run build:core
CORE="resources/bin/maximal-core"
if [ ! -s "$CORE" ]; then
  echo "::error::Sidecar not produced at client/${CORE}" >&2
  exit 1
fi
chmod 0755 "$CORE"
ls -la resources/bin/

# Bun's compile output carries a linker ad-hoc signature that Apple rejects.
# Strip it; @electron/osx-sign signs the copied binary inside Maximal.app during
# its single inside-out pass with hardened runtime + bun-runtime entitlements.
codesign --remove-signature "$CORE" 2>/dev/null || true

# Self-hosted runner: out/ persists across builds. Nuke it so every build
# regenerates the bundle from the freshly-stamped version (no stale Info.plist).
rm -rf out

# Build + inside-out sign ONLY the .app (no dmg — the builder packages +
# notarizes). Signing is enabled because SIGN_IDENTITY + MACOS_ENTITLEMENTS are
# exported (see forge.config.ts). --arch is pinned so the output dir name matches
# the config's app_path.
npm run package -- --arch="${ARCH}"

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

# The sidecar must be present in the bundle. It is NOT verified as signed: this
# producer cannot sign, and the builder signs it during sign_walk.
BUNDLED_CORE="${APP}/Contents/Resources/bin/maximal-core"
[ -f "$BUNDLED_CORE" ] || { echo "::error::Sidecar missing from bundle: ${BUNDLED_CORE}" >&2; exit 1; }

# Isolation tripwire, the inverse of the assertions this replaced. A Developer ID
# signature on a bundle this script built means the builder's keychain lock or
# its ad-hoc SIGN_IDENTITY has regressed, and untrusted client code is reaching
# the signing identity.
CS_OUT="$(codesign -dvv "$APP" 2>&1 || true)"
printf '%s\n' "$CS_OUT" | grep -E 'Identifier=|Authority=|Signature=|flags=' || true
if printf '%s\n' "$CS_OUT" | grep -q 'Authority=Developer ID Application'; then
  echo "::error::Producer output is Developer ID signed. It must not be able to sign — check the builder's keychain isolation." >&2
  exit 1
fi

echo "Producer done — ${APP} is unsigned and ready for the builder (sign_walk + top-level seal + dmg + notarize + staple + sha256)."
