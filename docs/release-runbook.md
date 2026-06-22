# Release runbook

Single source of truth for shipping a release. The flow is
release-please-driven and mostly automatic — the one human action is
merging the release PR (step 1). Every other step is a CI link to watch or
a recovery command.

---

## Pre-flight (optional — CI already gates the PR)

CI runs these on every PR, so a green release PR already means they pass.
Re-run locally only if you want to sanity-check before merging:

```sh
bun install
bun run lint
bun run typecheck
bun test
bun run build
```

## 1. Cut the release — merge the release PR

**Releases are release-please-driven and hands-off. There is no manual
tagging.** Conventional-commit `feat:`/`fix:` changes merged to `main`
accrue into an open **`chore(main): release X.Y.Z`** PR (release-please
bumps the version + writes `CHANGELOG.md`). Cutting the release is one
action: **merge that PR.**

On merge, `release-please.yml` does the rest automatically:

1. **Tags** `vX.Y.Z` (tag only — it does *not* create the GitHub Release;
   `release.yml` owns that, see *Why tag-only* in `release-please.yml`).
2. **Auto-dispatches `release.yml`** for the tag. A tag pushed by the
   default `GITHUB_TOKEN` does **not** fire `release.yml`'s `push: tags`
   trigger (GitHub's anti-loop guard suppresses it), so release-please
   dispatches it explicitly via `workflow_dispatch`, which isn't
   suppressed.
3. **Flips the merged PR's label** `autorelease: pending → tagged` so the
   *next* release PR can open. (release-please normally does this in its
   `github-release` step, which this pipeline skips — so a dedicated step
   does it instead. Without it, the next release PR is blocked.)

So the only human action is the merge. `release.yml` then builds, verifies,
publishes, and the post-publish `homebrew-tap` job bumps the formula — watch
it in step 2.

> **Version note (pre-1.0).** release-please is configured to bump *patch*
> even for `feat:`, so a feature ships as `0.4.x+1`. To force a version, put
> `Release-As: X.Y.Z` in a commit body (e.g. the squash-merge of the feature
> PR) *before* the release PR is cut.

### Fallback: manual tag (emergency only)

If release-please is unavailable, `release:manual` (bumpp) cuts + publishes
from a developer machine:

```sh
bun run release:manual   # bumpp prompts version; commits, tags, pushes; bun publish
```

A `GITHUB_TOKEN`-pushed tag still won't auto-fire `release.yml` — dispatch it
by hand (`--ref` MUST be the tag, and `tag` is a required input):

```sh
gh workflow run release.yml --ref vX.Y.Z -f tag=vX.Y.Z
```

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
| `macos-dmg` | ubuntu-latest → dispatches the private `stuffbucket/macos-builder` (self-hosted arm64 mac, holds the Apple secrets) | `*-darwin-arm64.dmg` (+ `.sha256`) — **signed + notarized + stapled** by the builder |
| `homebrew-tap` | ubuntu-latest (post-publish) | bumps `stuffbucket/homebrew-tap/Formula/maximal.rb` (see §5) |
| `windows-installer` | ubuntu-latest | `install.ps1` (+ `.sha256`) |
| `windows-msi` | windows-2022 | `*-windows-x64.msi` (+ `.sha256`) |
| `windows-msi-verify` | windows-2022 | gate only — silently installs the MSI, asserts install/registry/PATH, runs the installed binary, uninstalls, asserts clean removal |

If any job fails, the release stays a draft (never a half-published
"Latest"). Recover with **Actions → the release run → "Re-run failed
jobs"**, then re-run `publish`. The macOS bundle alone can also be
rebuilt from a developer Mac (§3) if the self-hosted runner is offline.

## 3. Build and attach the polished `.dmg` (legacy — superseded by `macos-dmg`)

The `macos-dmg` job (step 2) produces the signed + notarized `.dmg`
automatically by dispatching the private `stuffbucket/macos-builder` (or
re-run `macos-build.yml` manually: `gh workflow run macos-build.yml --ref
main -f tag=vX.Y.Z`). The steps below remain documented for an emergency
build from a developer Mac if the self-hosted builder is offline.

Run from any Apple Silicon developer Mac with this checkout. Auto-
detects the latest tag from `git describe`:

```sh
git fetch --tags
bun run release:dmg
```

This:
1. Downloads `*-darwin-arm64.tar.gz` for the latest tag.
2. Verifies SHA-256.
3. Assembles `maximal.app` from `build/macos/app-template/`.
4. Runs `npx create-dmg` (Mac-only — uses `hdiutil`).
5. Uploads `*-darwin-arm64.dmg` + `.sha256` to the GitHub release.

To build without uploading (e.g. for local testing):

```sh
bun run package-dmg --tag v0.1.0
# → dist-release/maximal-v0.1.0-darwin-arm64.dmg
```

## 4. Pre-publish smoke (manual, macOS-only)

CI smokes the windows-x64 binary. There's no CI Mach-O smoke under the
public-repo runner policy. Replace it with one developer-Mac check:

```sh
gh release download v0.1.0 --pattern '*-darwin-arm64.tar.gz' --dir /tmp/smoke
tar -xzf /tmp/smoke/maximal-v0.1.0-darwin-arm64.tar.gz -C /tmp/smoke
/tmp/smoke/maximal debug --json | jq '.version, .git'
```

If the JSON parses with the right version + commit, the binary is
loadable. (The `release:dmg` step above also unpacks and copies the
binary into the `.app`, which is its own loose smoke — but `debug
--json` is the explicit assertion.)

## 5. Homebrew formula (automated)

The `homebrew-tap` job in `release.yml` does this automatically after
`publish`: it renders the formula from `build/homebrew/maximal.rb` with the
just-released version + per-arch SHAs (`bun run render-formula`) and pushes
it to **`stuffbucket/homebrew-tap/Formula/maximal.rb`**. Users then:

```sh
brew install stuffbucket/tap/maximal     # taps stuffbucket/tap automatically
brew update && brew upgrade maximal       # later
```

Gating: the job needs the `HOMEBREW_TAP_TOKEN` secret (a fine-grained PAT
with Contents:write on `stuffbucket/homebrew-tap`). If it's unset the job
warns and skips — the release still publishes, but the formula won't bump
until someone re-runs `render-formula` by hand. The formula is
**Apple-Silicon-only** (no Intel build).

To re-render manually (e.g. the token was missing during the run):

```sh
bun run render-formula --org stuffbucket --version X.Y.Z \
  --output ../homebrew-tap/Formula/maximal.rb
# then commit + push in the tap repo
```

## 6. Announce

The Pages site (`docs/index.html`) auto-fetches the latest release via
the GitHub API at page load — no manual update needed there.

Internal wiki post / chat announcement is outside this runbook.

---

## Recovery

`release.yml` is built to be re-run. A failed build leaves the release a
**draft** (the `publish` job gates on every build via `needs:`), so nothing
half-publishes. To recover:

- **Re-run failed jobs:** Actions UI → the `release.yml` run → "Re-run
  failed jobs". The installers are all jobs *inside* `release.yml`
  (`binaries`, `macos-dmg`, `windows-installer`, `windows-msi`,
  `checksums`, …) — there is no separate `installers` workflow.
- **Self-heal:** the auto-dispatch step in `release-please.yml` re-fires
  `release.yml` on the next push to `main` (or a manual `release-please`
  dispatch) whenever the current version's tag exists but its release is
  still a draft. So a transient flake often fixes itself on the next
  commit.
- **Full re-run is idempotent.** The `release` job reuses an existing
  draft; asset uploads use `gh release upload --clobber`; `publish` flips
  draft→published exactly once and no-ops if already published; the
  per-tag `concurrency` group serializes re-runs so two can't race.
- **Manual dispatch** (if needed): `gh workflow run release.yml --ref
  vX.Y.Z -f tag=vX.Y.Z` (the `--ref` must be the tag).
- **Pull a release:** `gh release delete vX.Y.Z` + `git push --delete
  origin vX.Y.Z`. Only works while it's a **draft** — an
  already-published release is immutable (see below): the tag is frozen,
  re-cutting it won't work, **bump to a new patch version instead.**

<!-- NOTE: "Immutable releases" section added by the release-immutability
     task. If another agent is editing this runbook, sequence around this
     anchor to keep merges clean. -->

## Immutable releases

This repo has **GitHub Immutable Releases enabled** (a repository setting,
turned on 2026-06). Inspect or toggle it with:

```sh
gh api repos/stuffbucket/maximal/immutable-releases             # {"enabled":true,...}
gh api --method PUT  repos/stuffbucket/maximal/immutable-releases    # enable  → 204
gh api --method DELETE repos/stuffbucket/maximal/immutable-releases  # disable → 204
```

**What it guarantees:** once a release is *published*, its assets and its
Git tag are frozen — assets can't be added, replaced, or deleted, and the
tag can't be moved. This is a supply-chain protection: what you publish is
exactly what consumers verify against `SHA256SUMS`.

**Why our flow is already compatible:** GitHub's recommended pattern is
precisely what `release.yml` does — create the release as a **draft**,
attach *all* assets to the draft, then flip draft→published last.
Immutability locks at **publish time**, not at creation, so every
`gh release upload --clobber` in the upstream jobs (`release`, `binaries`,
`checksums`, `macos-dmg`, `windows-installer`, `windows-msi`) runs while
the release is still a draft and is unaffected. The `publish` job gates on
all of them via `needs:`, so no asset write lands after publish in the
happy path. The post-publish jobs (`homebrew-tap`, `redeploy-site`) only
*read* the release — they never mutate it.

**The one behavioral change:** you can no longer `--clobber` or otherwise
patch a release **after** it's published. The "Re-build the DMG" /
`gh release upload --clobber` recovery above only works while the release
is still a draft — i.e. before `publish` succeeds, or while a failed-job
re-run keeps it a draft. If you find a bad asset on an already-published
release, **do not try to patch it — cut a new patch version instead.**
Deleting and re-pushing the same tag won't help either, because the tag
itself is frozen.

## Open questions

- **Cert plumbing for A4** is still **DEFERRED** for the *raw binaries* —
  the bun-compiled `*-darwin-arm64.tar.gz` / `*-windows-x64.zip` (and
  Windows `signtool`) ship **unsigned** (see the `DEFERRED A4` stubs in
  `release.yml`). The macOS **`.dmg` is already signed + notarized** via
  the private `macos-builder`; A4 is only about signing the loose
  binaries. When the cred set lands, those gates flip to `if: …`.
- **`REPOMAN_APP_ID`** (a GitHub App token) is unset, so release-please
  tags via `GITHUB_TOKEN` — which is why the auto-dispatch + label-flip
  steps in `release-please.yml` exist (step 1). Provisioning the app
  would let release-please fire `release.yml` natively and own the label,
  removing both shims.
