# macOS installer assets — `build/macos/`

Inputs to two consumers:

1. The `installers.yml` `macos-app-zip` job (CI on `ubuntu-latest`),
   which produces `copilot-api-v<version>-darwin-arm64.app.zip` on
   every tag.
2. The `scripts/package-dmg.ts` local helper (Apple Silicon Mac
   only), which produces a polished `copilot-api-v<version>-darwin-
   arm64.dmg` post-tag via `npx create-dmg`.

Apple Silicon only — Intel macOS is not a supported target. v1 ships
unsigned (A4 deferred); first-launch right-click → Open is documented
on the Pages site.

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

## Build flow

### CI path — `.app.zip` (`installers.yml` `macos-app-zip` job)

Runs on `ubuntu-latest` for `arch=arm64` only:

1. Download `copilot-api-v<v>-darwin-arm64.tar.gz` + `.sha256` from
   the release; verify SHA.
2. Copy `app-template/` to `dist-build/copilot-api.app/`.
3. Substitute `__VERSION__` in `Contents/Info.plist`.
4. Replace `Contents/MacOS/copilot-api.placeholder` with the unpacked
   binary (preserve `+x` mode).
5. Replace `Contents/Resources/AppIcon.icns.placeholder` with the
   real icon when available; the placeholder is removed regardless.
6. `zip -ryX` the `.app` into `copilot-api-v<v>-darwin-arm64.app.zip`
   (reproducible byte output via `-X` and pinned mtimes).
7. Upload to the release.

### Local path — `.dmg` (`scripts/package-dmg.ts`)

Runs on a developer Mac post-tag:

1. Same download / verify / unpack as the CI path.
2. Same `.app` assembly.
3. `npx create-dmg --identity= …` (Mac-only; `hdiutil` under the hood).
4. Sidecar `.sha256`. Optional `--upload` attaches both to the release.

Both paths consume the same `app-template/` so substitutions stay in
sync.

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
