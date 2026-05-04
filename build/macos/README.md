# macOS installer assets — `build/macos/`

Inputs to the `installers.yml` workflow that produces the
`copilot-api-v<version>-darwin-{arm64,x64}.dmg` artifacts.

## Layout

```
build/macos/
  README.md                                            # this file
  app-template/                                        # .app skeleton, copied by CI
    Contents/
      Info.plist                                       # __VERSION__ substituted at build
      MacOS/
        first-launch                                   # shell shim; CFBundleExecutable
        copilot-api.placeholder                        # CI overwrites with real binary
      Resources/
        com.microsoft.copilot-api.plist                # launchd template; __HOME__ + __INSTALL_BIN__ substituted at first launch
        AppIcon.icns.placeholder                       # designer asset; replace before v1
  dmg-bg.png.placeholder                               # designer asset; replace before v1
```

## Build flow (per `.github/workflows/installers.yml`)

For each `(arch ∈ {arm64, x64})`:

1. Download the matching `copilot-api-v<v>-darwin-<arch>.tar.gz`
   artifact from the GitHub release.
2. Verify the `.sha256`.
3. Copy `app-template/` to `dist-build/copilot-api.app/`.
4. Substitute `__VERSION__` in `Contents/Info.plist`.
5. Replace `Contents/MacOS/copilot-api.placeholder` with the unpacked
   binary (preserve `+x` mode).
6. Replace `Contents/Resources/AppIcon.icns.placeholder` with the
   real icon (when available — until then, the .app launches fine
   with no icon, just a generic Finder placeholder).
7. Run `npx create-dmg` against `copilot-api.app` with the dmg
   background image — falls back to the create-dmg default when
   `dmg-bg.png` is still a placeholder.
8. Upload the resulting `.dmg` to the same release as the source
   tarball.

## Asset replacements before v1 ship

| File | What it is | Owner |
|---|---|---|
| `dmg-bg.png.placeholder` | 540×400 PNG: "Drag to Applications →", first-launch right-click → Open warning, MS branding | Designer |
| `app-template/Contents/Resources/AppIcon.icns.placeholder` | App icon, multi-resolution `.icns` | Designer |
| `app-template/Contents/MacOS/copilot-api.placeholder` | Empty stub; CI replaces with the real binary at build time | Stream B / CI |

The `.placeholder` extension keeps these out of git's blame for
binary content and makes it obvious which slots need real assets.
The `installers.yml` workflow looks for the `.placeholder` siblings
and either replaces them (binary, on every build) or fails with a
clear error (background, icon — designer hand-off).

## Sentinels in templates

| Sentinel | File | Substituted by |
|---|---|---|
| `__VERSION__` | `Contents/Info.plist` | CI workflow at build time |
| `__HOME__` | `Contents/Resources/com.microsoft.copilot-api.plist` | `first-launch` at first run on each user's machine |
| `__INSTALL_BIN__` | `Contents/Resources/com.microsoft.copilot-api.plist` | `first-launch` at first run |

Substitutions are literal `sed` replaces — the sentinels must match
exactly.

## Local testing

To assemble a `.app` from a developer checkout for ad-hoc testing
(no DMG, no signing):

```sh
cp -R build/macos/app-template /tmp/copilot-api.app
sed -i '' -e "s/__VERSION__/0.0.0-dev/g" /tmp/copilot-api.app/Contents/Info.plist
cp dist/copilot-api /tmp/copilot-api.app/Contents/MacOS/copilot-api
chmod +x /tmp/copilot-api.app/Contents/MacOS/copilot-api
rm -f /tmp/copilot-api.app/Contents/MacOS/copilot-api.placeholder
open /tmp/copilot-api.app
```

`Contents/MacOS/copilot-api` is required (the binary; `first-launch`
runs it via the `INSTALL_BIN` resolved path). The launchd plist
sentinels are substituted at first run, not at build time.
