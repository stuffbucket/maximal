# Release runbook

Maximal releases through two protected PR merges: the generated release PR,
then the generated updates-manifest PR. CI builds and verifies every asset before
publishing the GitHub release.

## Release checklist

1. Review the `chore(main): release X.Y.Z` PR, wait for its required `test`
   check, and confirm it is current with `main`.
2. Merge the release PR. Do not create or move a tag during the normal flow.
3. Open the resulting `release.yml` run and wait for every publish-gating job.
4. Confirm the GitHub release changes from draft to published.
5. Review the rolling `automation/updates-manifest` PR, wait for its required
   check, confirm it is current with `main`, and merge it.
6. Confirm the Pages deployment and the post-publication jobs complete.

CI already gates the release PR. For an optional local check, run:

```sh
bun run check:deep
```

Before the release PR is generated, `Release-As: X.Y.Z` in a commit body forces
an explicit version. Pre-1.0 `feat:` commits otherwise produce patch releases.

## Expected results

| Jobs | Expected result |
|---|---|
| `release`, `binaries`, `checksums`, `smoke` | Draft release, notes, SBOM, raw platform archives, checksums, and binary validation |
| `macos-dmg` | Signed, notarized, and stapled Apple Silicon DMG from `stuffbucket/macos-builder`, plus the app's updater bundle `maximal-vX.Y.Z-darwin-arm64.app.tar.gz` with its `.sig` and `.sha256`, checked against the checksum and verified as signed by the updater key for this version |
| `windows-installer`, `windows-msi`, `windows-msi-verify`, `windows-shell` | Windows installer assets and their required validation; `windows-shell` also verifies and attaches `<setup>.exe.sig`, the Windows app's updater signature |
| `linux-deb` | On Ubuntu 24.04 runners for amd64 and arm64: `maximal_X.Y.Z_<arch>.deb` built from the `linux-x64`/`linux-arm64` archives, and `maximal-desktop_X.Y.Z_<arch>.deb` (the Tauri tray app, which depends on `maximal (= <version>)` and ships no copy of its binaries), each with a `.sha256`; fails on a package over 95 MB |
| `linux-deb-smoke` | Installs both packages with apt in `debian:13`, `ubuntu:24.04` and `ubuntu:26.04` containers on both architectures and runs `build/linux/smoke-deb.sh` |
| `publish` | Publishes only after every required asset and verification gate succeeds |
| `homebrew-tap`, `manifest` | Independent post-publication distribution updates |

Each raw archive and installed application layout must contain `maximal` and
`maximal-mcp-broker` as executable siblings (`.exe` on Windows). On Linux the
`maximal` package installs both in `/usr/bin`, where `maximal-desktop` finds
them next to its own executable. The SBOM covers
both production dependency graphs. Shipping the Windows broker binary does not
enable supervision there; runtime remains fail-closed until kill-on-close Job
Object containment is implemented. The PowerShell installer owns a dedicated
ARP uninstaller that waits for the CLI cleanup, then removes both sibling
executables, its exact user-PATH entry, its ARP key, and itself. It refuses to
overwrite an MSI-managed installation, and its helper leaves MSI-owned files and
PATH registration to `msiexec` if an MSI was installed later.

A failed publish gate leaves the release as a draft. A post-publication failure
does not invalidate or roll back the immutable release.

## Protected manifest update

After publication, automation opens or updates the
`automation/updates-manifest` PR. It never pushes the generated manifest
directly to protected `main` and has no ruleset bypass. The PR updates
`site/public/updates/manifest.json`, which every app reads to offer
"Update to X.Y.Z", and `site/public/updates/desktop/<channel>.json`, which the
Windows and macOS apps install from. Until it merges and Pages deploys, the
apps can't install the release in place and send users to mxml.sh instead,
and apt doesn't offer it (see the apt repository below).

Merge the PR only after its required `test` check passes and its branch is
current with `main`. That ordinary protected merge triggers the Pages deploy.
If `main` advances or manifest generation fails, rerun the `manifest` job and
review the refreshed PR.

## apt repository

The same Pages deploy rebuilds the apt repository at `https://mxml.sh/apt`
(static files under `site/dist/apt/`, never committed):

1. `scripts/apt-repo-plan.ts` reads the merged manifest. The `stable` suite is
   built from `channels.stable.tag` and the `rc` suite from `channels.rc.tag`,
   so apt always carries the version the apps announce and nothing else.
2. `build/linux/apt-repo.sh fetch` downloads that release's four `.deb`s,
   checks each `.sha256`, and refuses a file over 95 MB (Pages serves files up
   to 100 MB and sites up to 1 GB; the deploy also fails over 800 MB).
3. `index` writes `Packages(.gz)` and `Release` with `apt-ftparchive`.
4. `sign` writes `InRelease` and `Release.gpg`.

A release without Linux packages (anything before them) is skipped with a
notice; with none at all, the site deploys without the repository. A channel
whose manifest entry lists Linux downloads its release doesn't have fails the
deploy, and the previous site stays live.

Signing uses the `APT_SIGNING_KEY` (armored private key) and
`APT_SIGNING_KEY_PASSWORD` secrets, visible only to the signing step, in a
temporary `GNUPGHOME`. The step fails unless the key's fingerprint equals the
`APT_SIGNING_KEY_FINGERPRINT` repository variable
(`7317FD604A591AFFC9235436C8270651B026DDF6`) and the committed public key
`site/public/apt/maximal.asc`, and it verifies each signature against that
public key. Rotating the key means replacing all four together and telling
Linux users to fetch the new public key.

## Recovery

| Failure | Action |
|---|---|
| A publish-gating job failed | Use **Re-run failed jobs** on the original `release.yml` run. |
| The release workflow was not dispatched | Run `gh workflow run release.yml --ref vX.Y.Z -f tag=vX.Y.Z`. |
| The macOS builder failed or was unavailable | Rerun `macos-dmg`, or run `gh workflow run macos-build.yml --ref main -f tag=vX.Y.Z`. |
| `manifest` failed after publication | Rerun `manifest`, then merge its protected PR after checks pass. |
| `homebrew-tap` failed | Rerun only `homebrew-tap`. |
| Pages deployment failed | Start a fresh run with `gh workflow run deploy-pages.yml --ref main`. |
| The apt step failed | Read its annotation: a missing or wrong signing secret or variable, a channel listing Linux packages its release lacks, or an oversized package. Fix it, then start a fresh Pages run. |
| A published asset is wrong | Cut a new patch release. |

If release-please itself is unavailable, a maintainer may prepare an emergency
version commit and tag with `bun run release:manual`, push the tag, then dispatch
`release.yml` with the command above. Maximal is not published to npm.

## Release safety and signing

- Published releases, tags, and assets are immutable. Attach and verify every
  asset while the release is still a draft.
- Never delete, retag, replace, or append assets after publication. Cut a new
  patch release for any correction.
- `publish` is the final draft-to-published transition.
- Generated manifest changes always travel through the protected PR described
  above.
- The private `stuffbucket/macos-builder` exclusively owns macOS packaging,
  signing, notarization, and stapling.
- The raw cross-compiled `*-darwin-arm64.tar.gz` remains unsigned. Any future
  signing for it belongs in `macos-builder`, not `release.yml`.
- Windows Authenticode signing remains deferred; the disabled placeholder in
  `release.yml` is the only signing stub retained.
- Both desktop apps' updates are signed for in-place install with Maximal's
  updater key (a minisign signature bound to the version, separate from
  Authenticode and Developer ID), key id `E8DAB79E2EB1D6C4`. The public half
  is `plugins.updater.pubkey` in `shell/src-tauri/tauri.conf.json`.
  - Windows: `windows-shell` builds with `createUpdaterArtifacts` using the
    `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
    secrets, which live in the `release` environment (deploys from `v*` tags
    only; the job declares `environment: release`), after checking that the configured public key equals the
    `TAURI_SIGNING_PUBLIC_KEY` variable.
  - macOS: `.macos-builder/config` asks for `artifact = dmg,updater`, and
    `stuffbucket/macos-builder` signs the bundle with its
    `TAURI_SIGNING_PRIVATE_KEY__MAXIMAL` secret (policy
    `updater_key_id = maximal`).
  - Both jobs run `scripts/verify-updater-signature.ts`, which fails the
    release unless the signature verifies against the configured public key
    and names the release version.
  - Rotating the key means changing the config and every copy of the key
    together. Apps already installed only accept updates signed with the key
    they shipped with.
