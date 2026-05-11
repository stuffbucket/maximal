# Tauri 2 shell spike

One-day spike validating whether to wrap the Bun-compiled `maximal`
proxy in a Tauri 2 menu-bar app, replacing the hand-rolled .app/.dmg
+ install.ps1 + WiX pipeline with Tauri's bundler.

## What's in here

- `src-tauri/` — Rust Tauri 2 host. ~150 lines of `lib.rs` covering:
  - sidecar spawn (`binaries/maximal-<host-triple>`) on app start
  - tray icon with three-item menu (dashboard, logs, quit)
  - on-demand webview window pointed at `localhost:4141/usage-viewer`
  - clean SIGTERM of the sidecar on `RunEvent::ExitRequested`
- `src/` — vanilla-ts vite scaffold left from `create-tauri-app`. We
  don't render any windows from it, but Tauri's bundler wants
  `frontendDist` to exist; deferred to a follow-up to slim it.
- `binaries/maximal-aarch64-apple-darwin` — local-only sidecar
  binary (gitignored). Build with:
  ```sh
  bun build --compile --target=bun-darwin-arm64 \
    --define '__MAXIMAL_VERSION__="0.0.0-spike"' \
    --define "__MAXIMAL_GIT_SHA__=\"$(git rev-parse HEAD)\"" \
    --define '__MAXIMAL_GIT_BRANCH__="spike/tauri-shell"' \
    ../src/main.ts --outfile binaries/maximal-aarch64-apple-darwin
  ```
  (run from `shell/src-tauri/`)

## How to build & run

```sh
cd shell
bun install
bunx tauri build --bundles app,dmg
open src-tauri/target/release/bundle/macos/maximal.app
```

Look for the maximal tray icon in the macOS menu bar. Click → Open
dashboard. Click → Quit (sidecar gets SIGTERM, app exits, port
4141 frees immediately).

## Validated

| Question | Answer |
|---|---|
| Sidecar spawn works on macOS arm64? | Yes — Tauri picks the host-triple-suffixed binary by convention |
| Stdout/stderr forwarding to parent? | Yes — `[maximal] …` lines stream into the Tauri host's stderr |
| Clean shutdown? | Yes — `CommandChild::kill()` sends SIGTERM, Bun handles it, port releases |
| Bundle size vs standalone .app.zip? | 27 MB DMG vs 28 MB today — overhead is essentially zero |
| Cross-origin access to localhost:4141 from the webview? | Yes — `bundle.macOS.exceptionDomain = "localhost"` plus the proxy's existing CORS middleware |

## NOT validated (deferred / out of spike scope)

- **Windows MSI**: Tauri's bundler emits `.msi` via WiX, but only on
  Windows hosts. Needs a Windows runner to validate.
- **Code signing + notarization**: spike binary is unsigned. Tauri 2
  has a documented `signingIdentity` config + `tauri-action` flow
  that wraps codesign/notarytool — same Developer ID we use today.
- **Auto-update via `tauri-plugin-updater`**: separate spike. Replaces
  "ship a new MSI/DMG and tell users to re-download."
- **First-run UX on Windows**: Tauri can register an HKCU\…\Run entry
  via the bundler config, replacing our current Start Menu shortcut.
  Patterns documented but not exercised here.
- **macOS LSUIElement (no Dock icon)**: spike still shows a Dock icon
  briefly on launch. One-line `Info.plist` patch.

## Recommendation

Promote the spike. Concrete next steps if we proceed:

1. Make the sidecar build a release-pipeline step. Drop the
   "matrix: artifact / target" job in `release.yml` in favor of a
   `tauri-action`-driven build that emits arch-specific `.dmg` +
   `.msi` directly.
2. Move signing/notarization into `tauri.conf.json` + GitHub Action
   inputs. The self-hosted Mac runner (already provisioned with our
   Developer ID + `maximal.keychain-db`) handles macOS; the existing
   GitHub-hosted Windows runners + Microsoft Trusted Signing handle
   Windows.
3. Wire `tauri-plugin-updater` for cross-platform auto-update.
4. Delete `build/macos/app-template/`, `build/windows/maximal.wxs`,
   `build/windows/install.ps1`, `scripts/package-dmg.ts` — Tauri
   subsumes all of them.
5. Keep the existing `bun build --compile` step for the CLI-only
   distribution path (`brew install`, `.tar.gz`, `.zip` for
   developers who want the binary without the tray).

## NOT recommended (rejected during spike)

- **Replacing CLI with the tray app entirely.** The bare CLI still
  has a constituency (CI users, scripted setups). Keep both.
- **Embedding the proxy logic into the Rust shell.** Our Bun source
  is the product; the Rust shell is a thin supervisor. Don't port
  ten thousand lines of TypeScript to Rust just to drop the sidecar
  process boundary.
