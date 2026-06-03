# Release runbook

Single source of truth for what a release engineer does for a `v*`
tag. Every step is either a command you can paste or a CI link to
watch.

---

## Pre-flight

```sh
bun install
bun run lint
bun run typecheck
bun test
bun run build
```

If any of those fail, fix and re-tag. The release CI runs the same
checks, so a green pre-flight here is a strong signal the release
job will pass.

## 1. Tag and push

`bumpp` handles version + tag + push in one step:

```sh
bun run release        # bumpp prompts for version; commits, tags, pushes
```

Or do it manually:

```sh
git tag -a v0.1.0 -m 'v0.1.0'
git push origin v0.1.0
```

The `release.yml` workflow triggers on the tag push.

## 2. Watch CI: `release` workflow

Wait for these jobs to all turn green. Each produces release assets:

| Job | Runner | Produces |
|---|---|---|
| `release` | ubuntu-latest | npm publish, `SBOM.cdx.json`, GitHub release notes |
| `binaries` (matrix × 2) | ubuntu-latest | `*-darwin-arm64.tar.gz`, `*-windows-x64.zip` (+ `.sha256` each) |
| `checksums` | ubuntu-latest | `SHA256SUMS` |
| `smoke` | windows-2022 | passes/fails — exec validation of the windows-x64 binary |

The installer jobs are part of the same `release.yml` run (no separate
`installers.yml` dispatch). `publish` gates on all of them via `needs:`,
so a slow Apple notarization just delays publish — it can't leave a
healthy build stuck as a draft on a wall-clock timeout:

| Job | Runner | Produces |
|---|---|---|
| `tauri-macos` (reusable `tauri-macos.yml`) | self-hosted (arm64 mac) | `*-darwin-arm64.app.zip` + `*-darwin-arm64.dmg` (signed + notarized + stapled, with sidecar) |
| `windows-installer` | ubuntu-latest | `install.ps1` (+ `.sha256`) |
| `windows-msi` | windows-2022 | `*-windows-x64.msi` (+ `.sha256`) |
| `windows-msi-verify` | windows-2022 | gate only — silently installs the MSI, asserts install/registry/PATH, runs the installed binary, uninstalls, asserts clean removal |

If any job fails, the release stays a draft (never a half-published
"Latest"). Recover with **Actions → the release run → "Re-run failed
jobs"**, then re-run `publish`. The macOS bundle alone can also be
rebuilt from a developer Mac (§3) if the self-hosted runner is offline.

## 3. Build and attach the polished `.dmg` (legacy — superseded by `tauri-macos`)

Since v0.4.1, the self-hosted macOS runner produces a signed +
notarized `.dmg` automatically via the reusable `tauri-macos.yml`
workflow (called by `release.yml`). The steps below remain documented
for emergency re-runs from a developer Mac if the runner is offline.

Run from any Apple Silicon developer Mac with this checkout. Auto-
detects the latest tag from `git describe`:

```sh
git fetch --tags
bun run release:dmg
```

This:
1. Downloads `*-darwin-arm64.tar.gz` for the latest tag.
2. Verifies SHA-256.
3. Assembles `copilot-api.app` from `build/macos/app-template/`.
4. Runs `npx create-dmg` (Mac-only — uses `hdiutil`).
5. Uploads `*-darwin-arm64.dmg` + `.sha256` to the GitHub release.

To build without uploading (e.g. for local testing):

```sh
bun run package-dmg --tag v0.1.0
# → dist-release/copilot-api-v0.1.0-darwin-arm64.dmg
```

## 4. Pre-publish smoke (manual, macOS-only)

CI smokes the windows-x64 binary. There's no CI Mach-O smoke under the
public-repo runner policy. Replace it with one developer-Mac check:

```sh
gh release download v0.1.0 --pattern '*-darwin-arm64.tar.gz' --dir /tmp/smoke
tar -xzf /tmp/smoke/copilot-api-v0.1.0-darwin-arm64.tar.gz -C /tmp/smoke
/tmp/smoke/copilot-api debug --json | jq '.version, .git'
```

If the JSON parses with the right version + commit, the binary is
loadable. (The `release:dmg` step above also unpacks and copies the
binary into the `.app`, which is its own loose smoke — but `debug
--json` is the explicit assertion.)

## 5. Homebrew formula (deferred)

Tap-repo PR not yet wired. When the deferral lifts, the steps will
be:

```sh
git clone <internal-org>/homebrew-tap ../homebrew-tap
bun run render-formula \
  --org <internal-org> \
  --version 0.1.0 \
  --output ../homebrew-tap/Formula/copilot-api.rb
( cd ../homebrew-tap && git checkout -b copilot-api-0.1.0 \
    && git add Formula/copilot-api.rb \
    && git commit -m 'copilot-api 0.1.0' \
    && git push -u origin HEAD \
    && gh pr create --fill )
```

Until then, Mac users install via `.app.zip` or `.dmg` from the
release page.

## 6. Announce

The Pages site (`docs/index.html`) auto-fetches the latest release via
the GitHub API at page load — no manual update needed there.

Internal wiki post / chat announcement is outside this runbook.

---

## Recovery

If you need to redo a step without re-tagging:

- **Re-run a CI job:** Actions UI → workflow → "Re-run failed jobs",
  or `workflow_dispatch` the `installers` workflow with `tag` set.
- **Re-build the DMG:** `bun run package-dmg --tag v0.1.0 --upload`
  (idempotent; `gh release upload --clobber` overwrites existing
  assets).
- **Pull a release:** `gh release delete v0.1.0` + `git push --delete
  origin v0.1.0`. Don't do this lightly — anyone who already
  downloaded gets stale URLs.

## Open questions

- **Internal repo URL** for the Homebrew tap (`<internal-org>` above).
  Step 5 stays deferred until this is decided.
- **Cert plumbing for A4** (codesign + notarize macOS, signtool
  Windows). When that lands, the `[DEFERRED A4]` steps in
  `release.yml` flip to `if: …` and signing happens automatically;
  this runbook stays unchanged.
