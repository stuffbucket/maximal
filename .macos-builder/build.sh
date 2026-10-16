#!/usr/bin/env bash
set -euo pipefail

# Maximal's Tauri producer for stuffbucket/macos-builder. It builds the unsigned
# Maximal.app at the config's `app_path`; the builder owns nested-code signing,
# top-level signing, packaging, notarization, stapling, and checksums.
#
# The producer runs with the signing keychain locked and SIGN_IDENTITY="-".
# The Bun sidecar is therefore left unsigned here and declared through the
# config's `sign_nested` key for Developer-ID signing after this script exits.
#
# Builder-supplied env consumed: TAG, ARCH, BUN_INSTALL, CARGO_HOME.

# Self-hosted runners use non-login shells that don't read ~/.zshrc.
export PATH="$HOME/.local/bin:$BUN_INSTALL/bin:$CARGO_HOME/bin:$PATH"

VERSION="${TAG#v}"
APP="shell/src-tauri/target/release/bundle/macos/Maximal.app"
SIDECAR="$APP/Contents/MacOS/maximal"
BROKER="$APP/Contents/MacOS/maximal-mcp-broker"
MISE_VERSION="v2026.9.5"
MISE="$HOME/.local/bin/mise"

echo "Producing Maximal.app for ${TAG} (version ${VERSION}, ${ARCH})"

# Tauri reads its version from tauri.conf.json, not git tags. Match whatever
# version is present, then assert the stamp so a sed no-op cannot ship the wrong
# CFBundleShortVersionString.
/usr/bin/sed -i '' -E "s/\"version\": \"[^\"]*\"/\"version\": \"${VERSION}\"/" \
  shell/src-tauri/tauri.conf.json
grep '"version"' shell/src-tauri/tauri.conf.json
if ! grep -q "\"version\": \"${VERSION}\"" shell/src-tauri/tauri.conf.json; then
  echo "::error::Failed to stamp version ${VERSION} into tauri.conf.json" >&2
  exit 1
fi

# Keep registry configuration in the runner's home directory; never add a
# repository .npmrc or use the npm CLI.
if [ ! -s "$HOME/.npmrc" ]; then
  printf '%s\n' 'registry=https://packagefeedproxy.microsoft.io/npm/' > "$HOME/.npmrc"
fi

bun install
bun install --cwd shell

# The isolated broker has its own frozen pnpm graph and toolchain.
mkdir -p "$HOME/.local/bin"
curl -fsSL https://mise.run \
  | MISE_VERSION="$MISE_VERSION" MISE_INSTALL_PATH="$MISE" sh
"$MISE" trust packages/mcp-broker/mise.toml
"$MISE" -C packages/mcp-broker install
"$MISE" -C packages/mcp-broker exec -- pnpm install --frozen-lockfile

# Leave the compiled sidecars unsigned. The builder strips any linker stamp and
# signs the in-bundle copies using the config's bun-runtime entitlement profile.
MAXIMAL_VERSION="$VERSION" MAXIMAL_FORCE_SIDECAR="1" bun run app:sidecar
ls -la shell/src-tauri/binaries/

# Persistent runners can retain a stale bundle and Info.plist between builds.
rm -rf shell/src-tauri/target/release/bundle

(
  cd shell
  bun run tauri build --bundles app
  ls -la src-tauri/target/release/bundle/macos/
)

BUILT_VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' \
  "${APP}/Contents/Info.plist" 2>/dev/null || echo '')"
echo "Built bundle version: ${BUILT_VERSION} (expected ${VERSION})"
if [ "${BUILT_VERSION}" != "${VERSION}" ]; then
  echo "::error::Bundle version '${BUILT_VERSION}' != release version '${VERSION}'. Stale build artifact?" >&2
  exit 1
fi
for binary in "$SIDECAR" "$BROKER"; do
  if [ ! -x "$binary" ]; then
    echo "::error::Declared executable sidecar not found at ${binary}" >&2
    exit 1
  fi
done

# The builder takes the app from here: sign_nested, top-level sign, package,
# notarize, staple, and checksum.
