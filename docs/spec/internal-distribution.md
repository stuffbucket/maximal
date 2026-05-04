# Internal distribution and installers — PRD

Status: Draft, 2026-05-04.
Owner: bstucker.
Scope: Take the proxy from "engineer-installable from source" to
"any Microsoft engineer or knowledge worker can drag-and-drop install
with no terminal interaction." Two parallelizable streams (A: CI/CD +
release artifacts; B: installers + post-install UX) with an explicit
contract between them so the work can be picked up by separate agents.

## TL;DR

- Audience is **internal Microsoft only**. Each user authenticates
  with their own Copilot Enterprise seat — same pattern Opencode uses
  with its built-in Copilot provider, and the same pattern endorsed
  for Copilot extensions. No public redistribution in v1.
- Distribution shape: signed per-arch single-file binaries published
  to GitHub Releases on the internal repo; Homebrew formula at
  `x3-design/homebrew-tap` for CLI users; `.pkg` for macOS drag-drop;
  `.msi` for Windows (with a signed PowerShell installer as fallback);
  static GitHub Pages landing site that auto-detects OS and links to
  the right artifact.
- Two agents, two streams. Stream A produces signed artifacts that
  Stream B consumes; the contract is the artifact naming convention
  and checksum publication location.
- Reuses existing infra: `x3-design/homebrew-tap`, the proxy's own
  config/state machinery, Cowork's MDM keys.

## Problem

Today the install path for an MS engineer is:

1. Install Bun (~30 s; usually they don't already have it).
2. Clone the repo from wherever it lives.
3. `bun install` (~5 s).
4. `bun src/main.ts auth` (~2 min interactive device code).
5. `bun run start` in a terminal (and keep it open, or daemonize).
6. Hand-edit `claude_desktop_config.json` to point at `localhost:4141`.
7. Decide on `coworkEgressAllowedHosts` and write it via `defaults`.

That's 8–15 minutes of CLI time for someone comfortable with terminals,
and a non-starter for anyone else. Past internal experience suggests
adoption craters at "install Bun" for non-engineers. Even for engineers,
keeping a terminal open as the runtime is brittle and nobody bothers
writing their own launchd plist.

## Goals

| Goal | Acceptance signal |
|---|---|
| One-click install on macOS | User downloads a `.pkg` from an internal page, double-clicks, enters password once, proxy is running and registered under launchd |
| One-click install on Windows | User downloads an `.msi`, double-clicks, accepts UAC, proxy is running as a Windows Service. Signed PowerShell installer acceptable fallback |
| CLI-friendly install on macOS | `brew install x3-design/x3-design/copilot-api` (or similar) installs and registers the service |
| Static landing page | An internal Pages URL shows version, OS-detecting download buttons, install instructions for both shapes |
| Claude Desktop configured automatically | Post-install hook updates `claude_desktop_config.json` to point at `localhost:4141` with a stub API key, preserving existing keys |
| Reproducible signed artifacts | Every release has a CI run, SBOM, SHA-256 checksums, macOS notarization ticket, Windows Authenticode signature |
| Diagnostic posture survives the install | After install, `copilot-api debug` from a terminal still produces the existing diagnostic output, including git SHA so support can confirm running version |
| Auto-update story documented | At minimum a runbook for "bump the formula / re-publish / Pages site picks up new release". Auto-update software optional |

## Non-goals

- **Public distribution.** External users not in scope for v1; deferred
  pending a separate decision on rollout scope.
- **Telemetry / phoning home.** Internal dev tool; users opt out by
  default. Not in scope.
- **Rebranding, GUI app, tray icon.** This is a background daemon plus
  the existing CLI. No SwiftUI/WinUI shell.
- **Auto-update infrastructure.** Manual re-install or `brew upgrade`
  is acceptable for v1.
- **Cross-arch builds without audience.** Linux excluded unless someone
  asks.

## Architecture

```
                    ┌──────────────────────────────┐
                    │  Stream A: CI/CD + release   │
                    │                              │
   git tag v* ────► │  - lint/typecheck/test       │
                    │  - bun build --compile       │
                    │  - codesign + notarize (mac) │
                    │  - signtool (win)            │
                    │  - SBOM + checksums          │
                    │  - publish to GH Releases    │
                    └──────────────┬───────────────┘
                                   │ artifact URLs +
                                   │ SHA-256 checksums
                                   ▼
                    ┌──────────────────────────────┐
                    │  Stream B: Installers + UX   │
                    │                              │
                    │  - Homebrew formula          │
                    │  - .pkg                      │
                    │  - .msi / .ps1               │
                    │  - GH Pages landing site     │
                    │  - Post-install setup hook   │
                    │  - launchd / Windows Service │
                    │  - Uninstall path            │
                    └──────────────────────────────┘
```

### Inter-stream contract

The contract between streams is **artifact naming + publication
location**:

```
<repo>/releases/download/v<version>/
  copilot-api-v<version>-darwin-arm64.tar.gz       # Stream A
  copilot-api-v<version>-darwin-arm64.tar.gz.sha256
  copilot-api-v<version>-darwin-x64.tar.gz         # Stream A
  copilot-api-v<version>-darwin-x64.tar.gz.sha256
  copilot-api-v<version>-windows-x64.zip           # Stream A
  copilot-api-v<version>-windows-x64.zip.sha256
  copilot-api-v<version>-darwin-arm64.dmg          # Stream B
  copilot-api-v<version>-darwin-x64.dmg            # Stream B
  copilot-api-v<version>-windows-x64.msi           # Stream B
  install.ps1                                      # Stream B
  SHA256SUMS                                       # Stream A (binaries)
  SBOM.spdx.json                                   # Stream A
```

Stream A publishes the `.tar.gz`/`.zip` + checksums + SBOM. Stream B
consumes them, builds the `.pkg`/`.msi`/`.ps1` in a separate workflow
that runs after Stream A's release succeeds, and re-attaches its
outputs to the same GitHub release.

## Stream A — CI/CD + release artifacts

### A1. Migrate to internal repo (coordination, not code)

Repo move + permissions + branch protection. Block on this for first
internal release.

**Deliverable:** repo URL on the internal GitHub org with main/dev
branches and required-reviews mirrored.

### A2. CI: lint + typecheck + tests + build on push/PR

Existing `.github/workflows/ci.yml` already does this per the M0–M6
audit (`c427177`). Confirm it survives the repo move (cache/secret
context changes) and add a Bun version matrix entry if Bun version
drift is a concern.

**Deliverable:** green CI badge on a PR that touches one file.

**Estimate:** ~2 hours.

### A3. Release CI: per-arch single-file binaries

New workflow triggered on `v*` tag.

```yaml
matrix:
  - { os: macos-14,    target: bun-darwin-arm64,  artifact: darwin-arm64 }
  - { os: macos-13,    target: bun-darwin-x64,    artifact: darwin-x64   }
  - { os: windows-2022, target: bun-windows-x64,  artifact: windows-x64  }

steps:
  - bun install --frozen-lockfile
  - bun build --compile --target=$target src/main.ts -o dist/copilot-api
  - tar -czf copilot-api-v$VERSION-$artifact.tar.gz -C dist copilot-api
  - sha256sum copilot-api-v$VERSION-$artifact.tar.gz > $@.sha256
```

**Deliverable:** a draft GitHub release with all three `.tar.gz`/`.zip`
files attached, executable on a clean VM of the target platform.

**Estimate:** ~150 LOC of GH Actions YAML; half a day to debug matrix
issues.

### A4. Code signing + notarization — **DEFERRED for v1**

Cred-set wiring (Apple Developer notarization + Microsoft Authenticode
signing service) deferred until after the unsigned-binary v1 lands and
we have evidence on whether the user-facing prompts are tolerable for
the internal audience. Stubs are left in `release.yml` as
`if: false`-gated `[DEFERRED A4]` steps so the wiring is in place when
the cred set is ready.

**v1 implications:**
- macOS: first launch shows a Gatekeeper "unidentified developer"
  prompt; right-click → Open bypasses (one-time per binary).
- Windows: SmartScreen "unrecognized app" warning on the `.ps1` /
  `.msi`; "More info → Run anyway" bypasses.
- Homebrew install path (B1) is unaffected.

When A4 unblocks:

- **macOS:** `codesign --deep --options=runtime` against the binary,
  then `xcrun notarytool submit` with Microsoft's Apple Developer
  credentials, then `xcrun stapler staple`. Reuse the internal CI's
  secret store / cert plumbing.
- **Windows:** `signtool sign` with the Microsoft Authenticode cert
  (HSM-backed; CI uses the existing internal signing service).

**Trigger to flip from deferred to active:** v1 user feedback indicates
the bypass UX is unacceptable, OR a compliance ask requires signed
artifacts.

**Estimate when re-activated:** ~half a day on macOS (well-trodden
path); ~1 day on Windows (signing-service integration is the long
pole).

### A5. SBOM + license scan + provenance

`bun pm ls --json` → CycloneDX or SPDX. License scan via
`license-checker` or equivalent, fail-on-disallowed-license. SLSA L2
provenance attached as a release asset.

**Deliverable:** every release has `SBOM.spdx.json` and license report;
CI fails if a dep introduces a non-permissive license.

**Estimate:** ~1 day; mostly tool selection and threshold tuning.

### A6. Smoke test on a clean image

CI step that downloads the just-built artifact onto a clean macOS /
Windows runner image, runs `copilot-api debug --json`, asserts the JSON
has the expected shape (version, git SHA matching the tag, default
config).

**Deliverable:** end-to-end signal that the artifact actually runs.
Catches static-link or missing-dep bugs the build step alone misses.

**Estimate:** ~half a day.

## Stream B — Installers + UX

### B1. Homebrew formula on `x3-design/homebrew-tap`

`copilot-api.rb`:

```ruby
class CopilotApi < Formula
  desc "Local proxy that exposes GitHub Copilot as the Anthropic API"
  homepage "https://github.com/<internal-org>/copilot-api"
  version "1.9.4"

  on_macos do
    on_arm do
      url     "<release-url>/copilot-api-v#{version}-darwin-arm64.tar.gz"
      sha256  "<from Stream A>"
    end
    on_intel do
      url     "<release-url>/copilot-api-v#{version}-darwin-x64.tar.gz"
      sha256  "<from Stream A>"
    end
  end

  def install
    bin.install "copilot-api"
  end

  service do
    run            [opt_bin/"copilot-api", "start"]
    keep_alive     true
    log_path       var/"log/copilot-api.log"
    error_log_path var/"log/copilot-api.err.log"
  end

  test do
    system bin/"copilot-api", "debug", "--json"
  end
end
```

Updates land via PRs to the existing tap. Auto-update is `brew
upgrade`.

**Deliverable:** one PR to `x3-design/homebrew-tap`. After merge,
`brew install x3-design/x3-design/copilot-api && brew services start
copilot-api` works.

**Estimate:** ~half a day plus tap-owner coordination.

### B2. macOS `.dmg` (drag-to-Applications)

A `.dmg` mounted from Finder shows a custom-background drag-target
view: `copilot-api.app` on the left, `Applications` symlink on the
right. User drags the app to Applications, double-clicks once to
self-install (registers launchd agent, runs `setup --unattended`),
sees a Notification Center toast, and is done.

Built with **`create-dmg`**
([sindresorhus/create-dmg](https://github.com/sindresorhus/create-dmg)) —
Node CLI, actively maintained, produces the canonical macOS UX. The
`.app` bundle wraps Stream A's compiled binary (`Contents/MacOS/
copilot-api`) plus a small `first-launch` shell shim that does the
self-install. Idempotent — re-launching from /Applications re-runs
the install.

`Info.plist` sets `LSUIElement = true` so the .app doesn't show in the
Dock or open a window when launched.

v1 ships unsigned per A4's deferral. The DMG background art and Pages
site (B4) surface the right-click → Open Gatekeeper bypass
instructions.

See `internal-distribution-stream-b.md` §7 for the full `.app`
template, first-launch script, and `create-dmg` invocation.

**Deliverable:** double-clickable `.dmg` that mounts the standard
macOS install view; one drag + one right-click-Open + one
`copilot-api setup` from terminal (for GitHub auth) leaves a working
setup. Steps 1-4 are mouse-only.

**Estimate:** ~2 days. The DMG generator integration + .app template
+ first-launch shim is the bulk; signing is deferred (A4).

### B3. Windows `.msi` (with PowerShell fallback)

#### B3a. Signed PowerShell installer (ship first if WiX slips)

`install.ps1` that:

- Downloads `copilot-api-v<version>-windows-x64.zip` + `.sha256`.
- Verifies checksum.
- Unpacks to `%LocalAppData%\Programs\copilot-api\`.
- Registers a per-user scheduled task (`schtasks /Create
  /TN copilot-api /TR ... /SC ONLOGON`).
- Updates `%APPDATA%\Claude\claude_desktop_config.json`.

Signed with the Authenticode cert from A4. Install command:

```powershell
iex (irm https://<internal>/copilot-api/install.ps1)
```

#### B3b. WiX MSI

WiX-based MSI:

- Drops `copilot-api.exe` at `%LocalAppData%\Programs\copilot-api\`
  (no admin required) or `%ProgramFiles%\copilot-api\` (admin install).
- Registers a Windows Service.
- Updates `%APPDATA%\Claude\claude_desktop_config.json`.
- Signed with Authenticode.

**Deliverable:** double-clickable `.msi` that finishes in <60 s and
leaves a running Windows Service. PowerShell fallback acceptable for
the first release if WiX slips.

**Estimate:** B3a ~half a day. B3b ~3 days (WiX learning curve).

### B4. GitHub Pages landing site

Single-page static site at `<repo>/docs/index.html` (or a `gh-pages`
branch).

- Detects OS via `navigator.userAgent`.
- Highlights the right download button (`.pkg` / `.msi` / `.tar.gz` /
  `brew` command); others below.
- Pulls latest release version from the GitHub API at page load (or
  baked-in via the release workflow updating a JSON file).
- Includes a `copilot-api debug` screenshot, a "what is this"
  two-paragraph blurb, and links to the internal wiki.

No SPA framework; vanilla HTML/CSS + maybe one fetch call.

**Deliverable:** internal URL where an MS engineer can land, click one
button, and have an installer in their Downloads folder.

**Estimate:** ~1 day.

### B5. First-run / `setup` subcommand

`copilot-api setup` as a new citty subcommand:

1. Checks whether `github_token` exists; if not, runs the device-code
   auth flow inline.
2. Probes `claude_desktop_config.json`; if not set up, deep-merges the
   minimal config to point at `localhost:4141`.
3. Verifies Cowork's `coworkEgressAllowedHosts` setting. If missing,
   prompts to set it to `["*"]` or run
   `scripts/install-cowork-egress.sh`.
4. Runs `copilot-api debug` and prints the result.
5. Tests the proxy with a one-shot `/v1/messages` call using the
   smallest model so the user sees "the proxy is alive" feedback.

Same logic the `.pkg` post-install script runs in unattended mode;
`setup` is the user-facing path.

**Deliverable:** a `setup` subcommand that takes a fresh-install user
from "binary just unpacked" to "Claude Desktop is talking to me" in
under two minutes.

**Estimate:** ~2 days. Claude Desktop config deep-merge is the
fiddliest part.

### B6. Uninstall path

- macOS: `copilot-api uninstall` (reverse of setup) and an
  `Uninstaller.app` in the `.pkg`. Removes binary, launch agent, and
  optionally the secrets directory (default no, prompt for yes).
- Windows: standard MSI uninstall via Add/Remove Programs; PowerShell
  uninstaller for the `.ps1` install path.
- Both: prompt before deleting `~/.local/share/copilot-api/secrets/`.

**Deliverable:** clean removal path that leaves no orphan launch
agents or service registrations.

**Estimate:** ~1 day.

## Sequencing

```
A1 → A2 → A3 ─┬─→ A5 → A6 ─→ first unsigned release
              │
              ├─→ B1 (Homebrew — unaffected by signing)
              ├─→ B2 (.pkg — unsigned in v1, Gatekeeper bypass)
              ├─→ B3a (.ps1) → B3b (.msi) (unsigned, SmartScreen bypass)
              │
              └────→ B5 (setup; pure CLI)
                     B6 (uninstall)
                     B4 (Pages — last; needs final release URLs)

A4 (signing + notarization) deferred — flip on after v1 if user
feedback or compliance requires it.
```

Constraints:

- A1, A2 are foundation; nothing else starts until A2 is green on the
  internal repo.
- A3 unblocks B1 (Homebrew needs a URL + SHA), B2, and B3 (the
  unsigned binaries are sufficient for v1).
- A4 (signing) is deferred; B2/B3 still ship in v1 with Gatekeeper /
  SmartScreen bypass UX.
- B5 has zero Stream A dependencies — Agent B starts here while Agent
  A is bootstrapping.
- B4 lands last because it references final artifact URLs.

## Risks

- **Apple Developer credential access in CI.** Notarization needs an
  Apple ID, app-specific password, and Team ID accessible to the GH
  Actions runner. Microsoft has this for other internal Mac tools;
  access scope needs sorting upfront.
  *Mitigation: Stream A's first deliverable after A2 is a notarization
  smoke test using a no-op binary, so the credential plumbing is proved
  before the rest of the pipeline depends on it.*

- **Authenticode signing service.** Internal MS signing is HSM-backed
  and rate-limited; CI integration historically requires a specific
  runner pool.
  *Mitigation: confirm runner-pool access in A4 day-one; if blocked,
  fall back to delayed-signing post-build.*

- **WiX learning curve.** If WiX is the long pole, ship B3a (PowerShell)
  alone in v1 and add MSI in a follow-up.
  *Mitigation: B3 is split into B3a then B3b; shipping B3a alone is
  acceptable.*

- **Claude Desktop config merge.** Overwriting user-set keys is a trust
  failure.
  *Mitigation: B5 implements deep-merge with a "we touch only these
  keys" allowlist (`inferenceProvider`, `inferenceGatewayBaseUrl`,
  `inferenceGatewayApiKey`); existing keys preserved.*

- **Bun `--compile` output size.** Single-file binaries are typically
  60–80 MB. Acceptable for a tool, worth noting for slow corp networks.
  *Mitigation: confirm size before A4; if >150 MB, investigate
  Bun-specific tree-shake flags.*

- **Repo move breaks existing CI cache / secrets.** Internal org may
  have different secret names.
  *Mitigation: A1 maintainer reviews CI YAML and renames cache keys /
  secrets in the same PR.*

- **Interactive auth flow inside `.pkg` post-install.** Running an
  interactive device-code flow as part of an installer is awkward.
  *Mitigation: `.pkg` finishes without auth; first launch attempts a
  request, gets 401, surfaces a notification asking the user to run
  `copilot-api setup` once.*

## Success criteria

End-to-end test: a colleague's clean macOS laptop, no prior
copilot-api exposure.

```
1. Visits internal Pages URL.
2. Clicks "Download for macOS (Apple Silicon)".
3. Double-clicks the .pkg.
4. Enters their password.
5. Runs `copilot-api setup` once (~2 min, paste GitHub device code).
6. Opens Claude Desktop, picks Cowork mode.
7. Asks Claude something, gets a response.
```

Same flow on Windows with `.msi` (or `.ps1`).

If a colleague who doesn't know what Bun is can complete that flow
without help in under 10 minutes, this PRD delivered.

## Out of scope (this PRD)

- Auto-update infrastructure (manual re-install acceptable in v1).
- GUI / tray app (background daemon only).
- Telemetry / error reporting.
- Cross-organization sharing inside MS — assumes one repo, one tap.
- Linux distribution (no audience yet).
- The decision on whether and when to broaden distribution beyond
  internal use.

## Agent split

**Agent A** owns Stream A. Deliverables in order:

1. **A1** — coordinate repo move (not code).
2. **A2** — verify CI on internal org.
3. **A3** — matrix release workflow producing unsigned per-arch
   tarballs.
4. **A5** — SBOM + license scan + provenance.
5. **A6** — smoke test on clean image.
6. **A4** — codesign + notarize macOS; signtool Windows. **Deferred
   for v1**; flip on after v1 feedback.

**Agent B** owns Stream B. Deliverables in order:

1. **B5** — `setup` subcommand. Pure CLI, no Stream A dependency;
   start here while A is bootstrapping.
2. **B1** — Homebrew formula. Depends on A3.
3. **B2** — macOS `.pkg`. Depends on A3; ships unsigned in v1
   (Gatekeeper bypass), re-signed automatically when A4 lands.
4. **B3a** — Windows PowerShell installer. Depends on A3; same
   unsigned/signed transition.
5. **B6** — uninstall paths.
6. **B3b** — WiX MSI. Depends on A3 + B3a learnings.
7. **B4** — Pages site. Depends on first release URL existing.

The contract is the artifact location and naming convention in the
"Inter-stream contract" subsection. Both agents read that as truth.
When Stream A produces a release, Agent B's installer workflows are
triggered automatically (or manually for v1) and re-attach to the
same GitHub release.
