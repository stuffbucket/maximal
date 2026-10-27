# Design: runtime version manifest for the site and the desktop updater

**Status:** Implemented.
**Date:** 2026-07-03.

## Decision

The release process writes a small, static manifest to a fixed, CDN-served
path. Every consumer — the marketing site and the desktop updater — reads
*that file* at runtime. No client queries the GitHub API.

- **No unauthenticated GitHub API calls from the browser.** The GitHub REST
  API is 60 req/hr/IP unauthenticated and a browser can't ship a token.
  Fetching a static object at a known URL is not API-rate-limited. (This is
  also why a GitHub release asset is the wrong host: discovering its URL
  from the browser requires the API.)
- **Fail-closed.** A fallback href and version baked into the initial HTML
  keep a working download for no-JS, crawlers, and manifest-fetch failures.
- **The manifest names its own tag**, so `releases/latest` propagation lag
  never matters.

## The data contract

`schema: 2`; the pure builder is `site/src/lib/updates-manifest.ts` (one
source of truth for the shape). Additive over schema 1: schema-1 desktop
clients read only `channels.<channel>.version`, which is unchanged.

```json
{
  "schema": 2,
  "generated": "2026-07-03T12:00:00.000Z",
  "channels": {
    "stable": {
      "version": "0.4.39",
      "tag": "v0.4.39",
      "notes": "https://github.com/stuffbucket/maximal/releases/tag/v0.4.39",
      "downloads": {
        "macos-arm64-dmg": {
          "name": "maximal-v0.4.39-darwin-arm64.dmg",
          "url": "https://github.com/stuffbucket/maximal/releases/download/v0.4.39/maximal-v0.4.39-darwin-arm64.dmg"
        },
        "windows-x64-setup": {
          "name": "maximal-v0.4.39-windows-x64-setup.exe",
          "url": "https://github.com/stuffbucket/maximal/releases/download/v0.4.39/maximal-v0.4.39-windows-x64-setup.exe"
        }
      }
    }
  }
}
```

- **`channels` is a map keyed by channel name.** `beta`/`nightly` use the
  identical object shape; an absent channel is simply not offered. The
  desktop client keys by `BUILD_CHANNEL`, so a beta binary reads
  `channels.beta`. The site reads only `stable`.
- **`downloads` is a map keyed by slot**, not an array. Slots are the
  `DownloadSlot` union in `updates-manifest.ts` (`macos-arm64-dmg`,
  `macos-x64-dmg`, `windows-x64-setup`, `windows-x64-msi`,
  `windows-x64-zip`, `windows-install-ps1`). The site picks an artifact by
  slot without name-sniffing; new slots need no schema bump; an absent slot
  means "not offered".
- **`notes`** is a display-only link to the GitHub release.

## Security property

The desktop client (`src/lib/update/update-check.ts`) reads **only**
`version` (`parseManifestVersion`); the download destination is the
hardcoded `DOWNLOAD_URL` constant, never `downloads.url`. A tampered
manifest can therefore at most misreport a version — never redirect a
download. `downloads` exists purely for the browser, where the URL is
user-visible and clickable anyway. **Do not wire the installer or any
auto-update flow to `downloads.<slot>.url`.**

## Hosting & write path

- The manifest is served at `/updates/manifest.json` on GitHub Pages
  (`https://mxml.sh/updates/manifest.json`, the Pages custom domain; the
  `stuffbucket.github.io/maximal/` path redirects there). The desktop client
  fetches it with a 6 h cache TTL and fails closed on any error.
- The source-of-truth file is the committed
  `site/public/updates/manifest.json`. Astro serves `site/public/**`
  verbatim, and a public file wins over the fallback route
  `site/src/pages/updates/manifest.json.ts` (which re-emits the same
  committed manifest if the file were ever absent).
- **The generated manifest PR is the only repository write path.** After a
  release publishes, release.yml's `manifest` job runs
  `scripts/write-updates-manifest.ts --tag <tag>` (read-modify-write, so a
  beta publish never clobbers `stable` and vice versa) on the rolling
  `automation/updates-manifest` branch and opens or updates a protected PR.
  It dispatches `ci.yml` against that PR's SHA because
  `GITHUB_TOKEN`-created PRs do not trigger `pull_request` workflows. A
  maintainer merge to `main` then triggers exactly one Pages deploy.
- The site build is offline and deterministic: `site/src/lib/version.ts`
  reads the committed manifest at build time to bake the fail-closed
  fallback, and the site's runtime hydration
  (`site/src/lib/hydrate-manifest.ts`, `hydrate-downloads.ts`) fetches the
  live manifest and rewrites download hrefs and the version pill. Runtime
  hydration can advertise a published release while its manifest PR awaits
  merge; the baked fallback advances only through protected `main`.

## Pages deploy operations

`deploy-pages.yml` runs on `push` to `main` filtered to `site/**` and the
workflow file, plus `workflow_dispatch`, with `concurrency: pages` and
`cancel-in-progress: true`.

**Re-run a failed Pages deploy with a fresh `workflow_dispatch`, never by
re-running the failed job.** `actions/deploy-pages` refuses a run that has
more than one artifact named `github-pages`, and re-running a job uploads
another copy. The workflow deletes any stale `github-pages` artifact before
upload as a guard, but a fresh dispatch is the safe path.
