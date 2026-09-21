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
| `macos-dmg` | Signed, notarized, and stapled Apple Silicon DMG from `stuffbucket/macos-builder` |
| `windows-installer`, `windows-msi`, `windows-msi-verify`, `windows-shell` | Windows installer assets and their required validation |
| `publish` | Publishes only after every required asset and verification gate succeeds |
| `homebrew-tap`, `manifest` | Independent post-publication distribution updates |

A failed publish gate leaves the release as a draft. A post-publication failure
does not invalidate or roll back the immutable release.

## Protected manifest update

After publication, automation opens or updates the
`automation/updates-manifest` PR. It never pushes the generated manifest
directly to protected `main` and has no ruleset bypass.

Merge the PR only after its required `test` check passes and its branch is
current with `main`. That ordinary protected merge triggers the Pages deploy.
If `main` advances or manifest generation fails, rerun the `manifest` job and
review the refreshed PR.

## Recovery

| Failure | Action |
|---|---|
| A publish-gating job failed | Use **Re-run failed jobs** on the original `release.yml` run. |
| The release workflow was not dispatched | Run `gh workflow run release.yml --ref vX.Y.Z -f tag=vX.Y.Z`. |
| The macOS builder failed or was unavailable | Rerun `macos-dmg`, or run `gh workflow run macos-build.yml --ref main -f tag=vX.Y.Z`. |
| `manifest` failed after publication | Rerun `manifest`, then merge its protected PR after checks pass. |
| `homebrew-tap` failed | Rerun only `homebrew-tap`. |
| Pages deployment failed | Start a fresh run with `gh workflow run deploy-pages.yml --ref main`. |
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
