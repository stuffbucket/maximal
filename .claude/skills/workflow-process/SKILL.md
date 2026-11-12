---
name: workflow-process
description: Use when preparing or merging a Maximal pull request, running the packaged Windows smoke workflow, cutting a stable or release-candidate build, monitoring release automation, updating the distribution manifest, recovering a failed release, or deploying or rolling back mxml.sh's pages.
version: 1.1.0
---

# Maximal Workflow Process

Use the protected repository workflows. Read the linked source of truth before acting; this skill is a decision guide, not a replacement for it.

## Choose the flow

| Intent | Required flow |
|---|---|
| Land a code change | Conventional Commit PR → required checks → protected merge |
| Verify packaged Windows behavior | Manually dispatch `windows-shell-dev.yml` on the change branch and wait for both build and install verification |
| Cut a stable release | Land a releasable `fix:` or `feat:` commit → generated release-please PR → protected merge |
| Cut an RC with an exact version | Land a releasable commit whose body contains `Release-As: X.Y.Z-rc.N` → verify the generated release-please PR proposes that exact version → protected merge |
| Recover release automation | Follow the recovery table in `docs/release-runbook.md`; preserve the existing tag and draft/release |
| Change or publish mxml.sh's pages (landing, guide) | Content lives in stuffbucket/maximal-site; follow its `publishing-mxml-content` skill. Here, only run `deploy-pages.yml` (see **mxml.sh pages**) |

## Code-change PRs

1. Read `docs/architecture.md` → **Release & PR conventions**.
2. Use one valid Conventional Commit type in every visible PR title and commit subject.
3. Run the checks appropriate to the change. Use `bun run check:fast` as the normal inner gate and `bun run check:deep` when the task or release warrants it.
4. Open a PR and wait for required checks.
5. Prefer squash for a one-shot branch. Use a merge commit only when individual commits must land or the branch will carry follow-up work.
6. Merge through branch protection; never push directly to `main`.

A squash uses the PR title as the commit subject and the PR body as the commit message. Put release metadata that must reach `main`, including `Release-As`, in the PR body and verify it is present in the landed commit.

## Packaged Windows verification

Read `.github/workflows/windows-shell-dev.yml` and `docs/architecture.md` → **Windows sidecar containment**. Dispatch the manual workflow against the exact branch or SHA under test, then wait for and inspect the complete run.

This workflow is verification only. It builds a synthetic package, exercises running reinstall, graceful configurator cleanup, exact process exit, abrupt Job Object containment, and running uninstall. It does not choose a release version, create a tag, or publish a release.

Do not run host installers, updaters, or integration configurators as a substitute for the isolated GitHub-hosted smoke.

## Stable and RC releases

Read `docs/release-runbook.md`, `.github/workflows/release-please.yml`, and `.github/workflows/release.yml` before acting.

1. Land the releasable code-change PR on `main`.
2. For an exact RC, ensure the landed commit body contains `Release-As: X.Y.Z-rc.N` before release-please generates or updates its PR.
3. Wait for the generated `chore(main): release X.Y.Z` PR. Confirm its version, changelog, required `test` check, and current base.
4. Merge that generated PR through branch protection.
5. Let `release-please.yml` create and push `vX.Y.Z`; never create or move the normal-flow tag by hand.
6. Let release-please dispatch `release.yml` for that tag. `release.yml` owns the draft release, assets, verification, signing, and single publish transition.
7. Wait for every publish-gating job and confirm the GitHub release is published. A hyphenated version is expected to publish as a prerelease.
8. Review the generated `automation/updates-manifest` PR, wait for its required check, confirm it is current, and merge it separately.
9. Confirm Pages and post-publication distribution jobs complete.

## mxml.sh pages

Read `docs/release-runbook.md` → **mxml.sh pages**. This repository owns the deploy, the domain, `/updates/*`, `/apt/*` and the `/maximal/` redirect. stuffbucket/maximal-site owns the pages, chosen by its tag matching the stable version in `site/public/updates/manifest.json`.

- Publish a content change without a release: `gh workflow run deploy-pages.yml --ref main` after the content is tagged in maximal-site.
- Roll back to this repository's old `site/` pages: `gh workflow run deploy-pages.yml --ref main -f source=legacy`.
- Don't edit pages under `site/src`; they only feed the legacy rollback.

## Recovery rules

- Failed publish gate: re-run failed jobs on the original `release.yml` run.
- Existing tag but missing dispatch: dispatch `release.yml` using that existing tag, exactly as documented in the runbook.
- Failed manifest job: re-run it and merge the refreshed protected manifest PR after checks.
- Failed Pages deploy: start a fresh Pages run from `main` as documented.
- Wrong published asset: cut a new patch release. Published releases, tags, and assets are immutable.
- Use `bun run release:manual` only when release-please is unavailable and a maintainer explicitly chooses the documented emergency path.

## Never shortcut

- Do not manually create, push, move, or delete a tag in the normal flow. (This repository's tags; stuffbucket/maximal-site's content tags are moved by hand on purpose.)
- Do not run `release.yml` from a branch or use it to manufacture a release without an existing version tag.
- Do not publish assets before all publish gates pass or append/replace assets after publication.
- Do not push generated manifest changes directly to `main`.
- Do not treat the Windows smoke workflow as a release mechanism.
- Do not bypass protected PRs, required checks, or repository confirmation rules.
