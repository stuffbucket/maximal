# Stream B handoff — installers + UX

This doc is the self-contained brief for the agent picking up Stream B
of `internal-distribution.md`. Read this end-to-end before opening any
file. Stream A (CI/CD + per-arch binaries) is owned by a parallel agent;
the contract between you is in §4 below.

## 1. 30-second context

`copilot-api` is a local proxy that exposes the GitHub Copilot API as
both an OpenAI-compatible and an Anthropic-compatible HTTP service. It
follows the same provider pattern Opencode uses for its built-in
Copilot integration: each user authenticates with their own Copilot
license, the proxy routes inference requests to the Copilot endpoint,
response shapes are translated. `src/main.ts` is the CLI entry; it
dispatches to `start`, `auth`, `check-usage`, `debug`. See the
top-level `README.md` for the architecture sketch and `CLAUDE.md` for
codebase conventions.

This proxy currently runs by `bun run start` from a developer checkout.
The goal of Stream B is to package it for non-developer Microsoft
employees: drag-and-drop install, no terminal, post-install Claude
Desktop wired up automatically.

## 2. Your scope

Six deliverables, in dependency order. Three of them (B5, B6) have
**zero dependency on Stream A** and you should start there while Stream
A bootstraps its CI.

| Item | Depends on | Status |
|---|---|---|
| **B5** First-run `setup` subcommand | nothing — pure CLI | start here |
| **B6** Uninstall paths | B5 (reverse of `setup`) | start with B5 |
| **B1** Homebrew formula | Stream A's first `.tar.gz` release | wait |
| **B2** macOS `.dmg` (drag-to-Applications) | Stream A3 (`.tar.gz` binary; unsigned in v1) | wait |
| **B3a** Windows PowerShell installer | Stream A3 (unsigned in v1) | wait |
| **B3b** Windows MSI (WiX) | B3a learnings | last in your queue |
| **B4** GitHub Pages landing site | first published release URL | last |

You can ship B3a alone in v1 if WiX (B3b) takes too long — acceptable
fallback per the parent PRD's risk section.

## 3. The contract with Stream A

Stream A produces per-arch binaries on every `v*` tag (unsigned in
v1; A4 will sign+notarize them once unblocked) and attaches them to
the GitHub release at:

```
<repo-url>/releases/download/v<version>/
  copilot-api-v<version>-darwin-arm64.tar.gz
  copilot-api-v<version>-darwin-arm64.tar.gz.sha256
  copilot-api-v<version>-darwin-x64.tar.gz
  copilot-api-v<version>-darwin-x64.tar.gz.sha256
  copilot-api-v<version>-windows-x64.zip
  copilot-api-v<version>-windows-x64.zip.sha256
  SHA256SUMS
  SBOM.spdx.json
```

Your installers consume those URLs + SHAs and **re-attach** their own
outputs (`.dmg`, `.msi`, `install.ps1`) to the same release.

Don't change this contract without coordinating with Stream A. The
artifact names are baked into the Homebrew formula, the Pages site,
and any CI you write to repackage the binaries.

## 4. B5 — `setup` subcommand (start here)

### Goal

After installing the binary (by any means), running `copilot-api setup`
once should take a fresh user from "binary just unpacked" to "Claude
Desktop is talking to me" in under two minutes, with no editing of
config files by hand.

### Steps the subcommand does

1. **GitHub auth**. Check `state.githubToken` (loads from
   `~/.local/share/copilot-api/<oauth-app>/github_token` per `PATHS`).
   If missing, run the existing device-code flow (see
   `setupGitHubToken()` in `src/lib/token.ts:128`).
2. **Claude Desktop config**. Read
   `~/Library/Application Support/Claude/claude_desktop_config.json`
   (macOS) / `%APPDATA%\Claude\claude_desktop_config.json` (Windows).
   Deep-merge our keys; do NOT overwrite existing user keys.
   - `inferenceProvider: "gateway"`
   - `inferenceGatewayBaseUrl: "http://localhost:4141"`
   - `inferenceGatewayApiKey: "anything"` (the proxy accepts any
     non-empty bearer)
   See `docs/admin/claude-desktop-mdm.md` §"Key reference" for the
   full schema and `src/debug.ts:summarizeConfig` for an example of
   how the project structures config reads.
3. **Cowork egress**. Read
   `defaults read com.anthropic.claudefordesktop coworkEgressAllowedHosts`
   (macOS) or the Windows equivalent. If unset, prompt the user with
   three choices: `["*"]` (allow-all), run
   `scripts/install-cowork-egress.sh` (curated list), or skip. See
   `docs/admin/claude-desktop-mdm.md` for what each means.
4. **Diagnostic**. Run the existing `copilot-api debug` rendering
   (call `runDebug({ json: false })` from `src/debug.ts`) and print
   the result so the user sees what the proxy thinks its config is.
5. **Smoke test**. Issue a one-shot `/v1/messages` request to the
   running proxy using the smallest model. If the proxy isn't running,
   start it in the background or instruct the user to. Either is
   fine; pick one.

### Implementation guidance

- Add as a new `citty` subcommand in `src/setup.ts`, registered in
  `src/main.ts` next to `auth`/`start`/`debug`.
- Use the existing config primitives — don't re-implement JSON
  read/write. `getConfig()` and `mergeConfigWithDefaults()` are in
  `src/lib/config.ts`.
- For the Claude Desktop config merge, write a small helper
  `src/lib/claude-desktop-config.ts` that:
  - reads the file (returns `{}` on absent or unreadable)
  - merges only the three keys above (allowlist, not deep-merge of
    everything)
  - writes back atomically (write to `.tmp`, rename)
- Tests: `tests/claude-desktop-config.test.ts` with a tmp-dir fixture.
  Cover: file absent, file present-with-other-keys, file present-with-our-keys-already.

### Acceptance signal

A clean macOS account that has never run the proxy can:

```
$ copilot-api setup
✓ GitHub authenticated as <user>
✓ Claude Desktop config updated
✓ Cowork egress: ["*"]
✓ Proxy responds to /v1/messages with claude-haiku-4.5 ("hello")
```

Total elapsed wall-clock <2 min, of which ~90s is the user pasting the
GitHub device code.

### Estimate

~2 days. Most of the time is in the deep-merge logic and the smoke
test — the GitHub auth flow already exists.

## 5. B6 — Uninstall

### Goal

Reverse of `setup`: remove the binary, the launchd plist / Windows
service, and *optionally* the secrets directory. Default no on the
secrets, prompt for confirmation.

### Steps

1. Stop the running proxy. macOS: `launchctl bootout`. Windows: stop
   service via `sc.exe stop`.
2. Remove launchd plist / unregister Windows service.
3. Remove the binary (`/usr/local/bin/copilot-api` or
   `~/.local/bin/copilot-api` / `%LocalAppData%\Programs\copilot-api\`).
4. Optionally remove `~/.local/share/copilot-api/secrets/` and
   `github_token`. Default no, prompt with `--purge` flag for non-interactive.
5. Optionally revert the Claude Desktop config touches from B5.
   Default no — the user might still want their `inferenceProvider`
   set even after our binary is gone.

### Implementation

- New citty subcommand `uninstall` in `src/uninstall.ts`.
- Same shared helper from B5 for Claude Desktop config (revert mode).

### Acceptance

```
$ copilot-api uninstall
✓ launchd agent stopped + removed
✓ binary removed from ~/.local/bin/copilot-api
ℹ secrets dir kept (use --purge to remove)
ℹ Claude Desktop config left as-is (use --revert-claude to clean up)
```

### Estimate

~1 day.

## 6. B1 — Homebrew formula (waits on Stream A)

Once Stream A publishes its first signed release, open a PR to
`x3-design/homebrew-tap` adding `copilot-api.rb`. Skeleton in the
parent PRD §"B1". Get the `sha256` from
`<release-url>/copilot-api-v<version>-darwin-{arm64,x64}.tar.gz.sha256`.

The formula's `service do` block automatically registers the proxy
under `brew services`, replacing the launchd plist work for Homebrew
users. Confirm it picks up environment variables (specifically
`OLLAMA_API_KEY` if set in the user shell).

### Acceptance

A teammate with the tap added can run:

```
brew install x3-design/x3-design/copilot-api
brew services start copilot-api
copilot-api setup
```

and have a working setup.

### Estimate

~half a day plus tap-owner coordination time.

## 7. B2 — macOS `.dmg` (waits on Stream A3)

### Goal

A `.dmg` that mounts to a familiar drag-to-Applications view with
custom background, branded icon, and an `Applications` symlink. User
drags `copilot-api.app` to Applications, double-clicks to launch
once, and the app self-installs as a launchd agent then exits. v1
ships unsigned — the Pages site (B4) and DMG background art surface
the right-click → Open Gatekeeper bypass instructions.

A4 (signing/notarization) is deferred per the parent PRD; the build
pipeline produces an unsigned `.app` and `.dmg` for v1, ready to be
re-signed automatically when A4 unblocks.

### Why DMG over PKG

- DMG with custom background art is the iconic "drag into Applications"
  UX; non-engineers recognize it instantly.
- PKG triggers a system Installer flow that asks for a password — fine
  for engineers, friction for everyone else.
- DMG handles the .app gracefully; .app is a single drag-target.
- The first-launch self-install pattern means the .app *is* the
  installer — no separate post-install scripts to maintain.

### `.app` bundle structure

```
copilot-api.app/
  Contents/
    Info.plist                          # LSUIElement=1 (no Dock icon),
                                        # CFBundleIdentifier =
                                        #   com.microsoft.copilot-api,
                                        # CFBundleVersion from CI
    MacOS/
      copilot-api                       # the bun --compile binary
      first-launch                      # tiny shell launcher (see below)
    Resources/
      com.microsoft.copilot-api.plist   # launchd plist template
      AppIcon.icns
```

`Info.plist` essentials:

- `CFBundleExecutable` = `first-launch` (not the binary directly — the
  shim handles install-vs-already-installed).
- `LSUIElement` = `<true/>` so the .app doesn't appear in the Dock or
  show a window when launched.
- `CFBundleIdentifier` = `com.microsoft.copilot-api`.

`Contents/MacOS/first-launch` (~30 lines of bash):

```bash
#!/bin/bash
set -e
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BIN_SRC="$APP_DIR/MacOS/copilot-api"
PLIST_SRC="$APP_DIR/Resources/com.microsoft.copilot-api.plist"

INSTALL_BIN="$HOME/.local/bin/copilot-api"
INSTALL_PLIST="$HOME/Library/LaunchAgents/com.microsoft.copilot-api.plist"

# Install binary + plist (idempotent — overwrite any older install).
mkdir -p "$(dirname "$INSTALL_BIN")" "$(dirname "$INSTALL_PLIST")"
cp -f "$BIN_SRC"    "$INSTALL_BIN"
cp -f "$PLIST_SRC"  "$INSTALL_PLIST"
chmod 755 "$INSTALL_BIN"

# (Re)load the launch agent.
launchctl bootout  "gui/$(id -u)" "$INSTALL_PLIST" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$INSTALL_PLIST"

# Claude Desktop config in unattended mode (B5; skip GitHub auth here).
"$INSTALL_BIN" setup --unattended --skip-auth || true

# Notify and exit. No long-lived process from the .app itself.
osascript -e 'display notification "copilot-api installed. Run `copilot-api setup` once from a terminal to authenticate." with title "copilot-api"'
exit 0
```

The `.app` is therefore a one-shot self-installer. Future launches
re-run `first-launch` (idempotent), so users can re-install just by
double-clicking the .app from /Applications.

### DMG generator

Use **`create-dmg`**
([sindresorhus/create-dmg](https://github.com/sindresorhus/create-dmg))
— Node CLI, actively maintained, produces the canonical macOS install
UX (custom background, drag-to-Applications symlink, no terminal).
Alternatives considered:

- `appdmg` — older, JSON-spec; less polished defaults than create-dmg.
- `dmgbuild` (Python) — full programmatic control; overkill for our
  shape and adds a Python toolchain dep.

`create-dmg` accepts a built `.app` and emits a `.dmg`:

```sh
npx create-dmg copilot-api.app dist-release/ \
  --dmg-title "copilot-api ${VERSION}" \
  --background build/macos/dmg-bg.png \
  --window-size 540,400 \
  --icon-size 128 \
  --app-drop-link 380 200
```

### Build pipeline

CI workflow `installers.yml` runs after `binaries`:

```
needs: binaries
runs-on: macos-14
steps:
  - download copilot-api-v<v>-darwin-arm64.tar.gz from release
  - assemble copilot-api.app from build/macos/app-template/
  - copy unpacked binary into Contents/MacOS/copilot-api
  - npx create-dmg ...
  - upload .dmg to the same GitHub release
  - matrix x2 for arm64 + x64
```

Same pattern repeated for darwin-x64 — two .dmg artifacts per release
(`copilot-api-v<v>-darwin-arm64.dmg`, `copilot-api-v<v>-darwin-x64.dmg`).

### DMG background art

`build/macos/dmg-bg.png` — 540×400 image with:

- "Drag copilot-api to Applications →" arrow overlay.
- Microsoft branding (subtle).
- A "First launch: right-click → Open" footer line in small text,
  since the v1 binaries are unsigned. Treat this as a load-bearing
  UX detail; it's the most asked-about gotcha.

### Acceptance

On a clean macOS Sonoma+ machine:

1. Download `copilot-api-v<v>-darwin-arm64.dmg` from the Pages site.
2. Double-click → DMG mounts, drag-to-Applications view opens.
3. Drag `copilot-api.app` onto the Applications symlink.
4. Open `/Applications/copilot-api.app` once (right-click → Open
   first time to bypass Gatekeeper); a notification confirms install.
5. Run `copilot-api setup` from a Terminal once to handle GitHub
   auth (B5).
6. Open Claude Desktop, switch to Cowork, ask Claude something.

Steps 1-4 are mouse-only; step 5 is the one terminal step (auth flow
is interactive by nature). Acceptable for v1.

### Estimate

~2 days. The DMG generator + `.app` template + first-launch script
is the bulk; signing / notarization stays deferred per the parent PRD.

## 8. B3 — Windows installer

### B3a — PowerShell installer (ship first)

Self-contained signed `install.ps1` that:

1. Downloads `copilot-api-v<version>-windows-x64.zip` and `.sha256`
   from GitHub Releases.
2. Verifies checksum (`Get-FileHash -Algorithm SHA256`).
3. Unpacks to `$env:LOCALAPPDATA\Programs\copilot-api\`.
4. Adds that dir to user PATH (`[Environment]::SetEnvironmentVariable`).
5. Registers a per-user scheduled task on logon:

   ```powershell
   $action  = New-ScheduledTaskAction -Execute "$installDir\copilot-api.exe" -Argument "start"
   $trigger = New-ScheduledTaskTrigger -AtLogOn
   Register-ScheduledTask -TaskName "copilot-api" -Action $action -Trigger $trigger
   ```

6. Runs `copilot-api setup --unattended --skip-auth` for Claude
   Desktop config.

v1 ships unsigned (A4 deferred); SmartScreen surfaces "More info →
Run anyway" on first run. User install command:

```powershell
iex (irm https://<internal>/copilot-api/install.ps1)
```

### B3b — WiX MSI (later)

WiX `.wxs` defining:

- File component for `copilot-api.exe` in `%LocalAppData%\Programs\copilot-api\`.
- Service install via `ServiceInstall` element.
- Custom action calling `copilot-api setup --unattended` post-install.

Built in CI on a `windows-2022` runner. Signed with Authenticode.

WiX has a learning curve. **Ship B3a first**; B3b can come in v2.

### Acceptance

User downloads `install.ps1` from internal Pages site, runs it from a
PowerShell window, accepts SmartScreen prompt (signed binary should
not trigger), proxy starts as a scheduled task on next logon, Claude
Desktop is configured.

### Estimate

B3a: ~half a day. B3b: ~3 days.

## 9. B4 — GitHub Pages landing site (last)

Drop `docs/index.html` (or use the existing `gh-pages` branch — see
`.github/workflows/deploy-pages.yml`, already configured). Single page,
no SPA framework.

### Required behavior

1. On load, `fetch` the GitHub Releases API for the latest release;
   parse the version + asset URLs.
2. UA-detect the OS (`navigator.platform` / `navigator.userAgent`).
3. Show one big primary button matching the detected OS:
   - macOS Apple Silicon: `.dmg` (arm64)
   - macOS Intel: `.dmg` (x64)
   - Windows: `.msi` (or `.ps1` instructions block)
4. Below the primary button: secondary buttons for the other shapes
   (`brew` install command, `.tar.gz` direct download,
   `install.ps1` link).
5. A 2-paragraph "what is this" section above the buttons.
6. **First-launch warning callout** — load-bearing UX detail. v1
   binaries are unsigned, so macOS users see Gatekeeper's
   "unidentified developer" prompt and Windows users see
   SmartScreen. Render an explicit instruction block:
   - *macOS:* "First launch: right-click `copilot-api.app` in
     Applications → Open → confirm Open in the dialog."
   - *Windows:* "First launch: SmartScreen → More info → Run anyway."
   - *Brew install:* unaffected — `brew` bypasses Gatekeeper.
7. A screenshot of `copilot-api debug` output (saved as static asset
   in `docs/`) so admins can sanity-check the install.
8. A link to the internal wiki page (URL TBD by team).

Vanilla HTML + CSS. One `fetch` call, one `if` ladder for OS
detection. <300 LOC total.

### Acceptance

The internal Pages URL renders, OS-detect picks the right primary
button, all download links resolve to the latest release's signed
artifacts, the brew command line works after copy/paste.

### Estimate

~1 day.

## 10. Coordination notes

- **When Stream A publishes its first release**, ping the parent
  channel; you'll need the actual `.tar.gz` SHA-256 values for B1
  and to verify B2/B3a artifact-fetching code.
- **If your B2 post-install script needs to know about new
  config keys**, propose them as an addition to `src/debug.ts`
  `summarizeConfig` and the parent PRD — don't add a parallel
  read path.
- **Don't touch Stream A's release workflows.** If you need a
  different artifact (e.g., a directory bundle instead of a tar.gz),
  raise it in the parent issue rather than forking the build.
- **Keep test coverage.** Each new subcommand (`setup`, `uninstall`)
  needs at least one test. The Claude Desktop config helper needs
  edge-case coverage (file absent, file with conflicting keys, etc.).

### CI / actions policy

Internal MS GitHub Actions environments **reject non-MS/GitHub-sourced
actions** for supply-chain reasons. Vendored replacements live under
`.github/actions/` and are referenced via local paths
(`uses: ./.github/actions/<name>`).

Already vendored (use these in `installers.yml`):
- `./.github/actions/setup-bun` — replaces `oven-sh/setup-bun`.
- `./.github/actions/upload-release-asset` — replaces
  `softprops/action-gh-release`. Inputs: `tag`, `files` (newline-
  separated paths). Shells to `gh release upload --clobber` so
  re-runs are idempotent. See its `action.yml` for the full
  surface.

Allowed without vendoring (first-party):
- `actions/checkout`
- `actions/setup-node`
- `actions/configure-pages`, `actions/upload-pages-artifact`,
  `actions/deploy-pages` (B4 only)

Don't introduce these in B2/B3/B4 workflows (vendor first):
- Any `docker/*` action — the existing `release-docker.yml` uses
  several of these and has been disabled (manual `workflow_dispatch`
  only). B2/B3 don't need any Docker actions.
- `sigstore/cosign-installer` — same posture as `docker/*`.
- Anything else not on the GitHub-published list above.
- Any third-party tool wrapped as a GHA — prefer the underlying CLI
  via the runner's preinstalled tooling, or vendor the action under
  `.github/actions/<name>/action.yml` as a composite first.

For B2 specifically: `npx create-dmg` is an npm package, not a GHA,
and is fine to run via `npx` in a step. Same logic for B3a's
`signtool.exe` (preinstalled on `windows-2022` runners) and any
PowerShell signing utility — those are CLI tools, not actions.

## 11. Files you'll create / modify

```
src/setup.ts                            # B5 (new)
src/uninstall.ts                        # B6 (new)
src/lib/claude-desktop-config.ts        # B5 helper (new)
src/main.ts                             # B5/B6 — register subcommands
tests/setup.test.ts                     # B5 (new)
tests/uninstall.test.ts                 # B6 (new)
tests/claude-desktop-config.test.ts     # B5 helper (new)
build/macos/app-template/Info.plist     # B2 — .app metadata (LSUIElement)
build/macos/app-template/MacOS/first-launch  # B2 — self-install shim (~30 LOC bash)
build/macos/com.microsoft.copilot-api.plist  # B2 — launchd plist template
build/macos/dmg-bg.png                  # B2 — DMG background w/ "drag to /Applications"
build/macos/AppIcon.icns                # B2 — app icon
build/windows/install.ps1               # B3a (new)
build/windows/copilot-api.wxs           # B3b (new)
.github/workflows/installers.yml        # B2 + B3 — runs after Stream A's release
docs/index.html                         # B4 (new)
docs/install-screenshot.png             # B4 — `copilot-api debug` capture
```

That's the full surface. Anything beyond is scope creep — confirm
before adding.

## 12. Where to ask

- Parent PRD: `docs/spec/internal-distribution.md`
- Stream A handoff (for symmetric context): `docs/spec/internal-distribution-stream-a.md`
- Architecture / codebase: `CLAUDE.md`
- MDM and Cowork details: `docs/admin/claude-desktop-mdm.md`
