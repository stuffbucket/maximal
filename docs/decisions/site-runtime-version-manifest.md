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
  `windows-x64-zip`, `windows-install-ps1`, `linux-{amd64,arm64}-deb`,
  `linux-{amd64,arm64}-desktop-deb`). The site picks an artifact by
  slot without name-sniffing; new slots need no schema bump; an absent slot
  means "not offered". The Pages deploy builds the apt repository from the
  tags `channels.stable` and `channels.rc` name, and fails when a channel
  lists a Linux slot its release doesn't carry.
- **`notes`** is a display-only link to the GitHub release.

## Security property

The desktop client (`src/lib/update/update-check.ts`) reads **only**
`version` (`parseManifestVersion`); the download destination is the
hardcoded `DOWNLOAD_URL` constant, never `downloads.url`. A tampered
manifest can therefore at most misreport a version — never redirect a
download. `downloads` exists purely for the browser, where the URL is
user-visible and clickable anyway. **Do not wire the installer or any
auto-update flow to `downloads.<slot>.url`.**

## Desktop updater manifest

The Windows and macOS apps install updates in place with
`tauri-plugin-updater`, which reads a separate document per channel in
Tauri's static JSON format: `https://mxml.sh/updates/desktop/<channel>.json`
(source file `site/public/updates/desktop/<channel>.json`; builder
`buildDesktopManifest` in `updates-manifest.ts`).

```json
{
  "version": "0.4.49",
  "notes": "https://github.com/stuffbucket/maximal/releases/tag/v0.4.49",
  "pub_date": "2026-10-28T12:00:00Z",
  "platforms": {
    "windows-x86_64-nsis": { "url": "<setup.exe release asset>", "signature": "<setup.exe.sig content>" },
    "windows-x86_64": { "url": "<same>", "signature": "<same>" },
    "darwin-aarch64-app": { "url": "<darwin-arm64.app.tar.gz release asset>", "signature": "<.app.tar.gz.sig content>" },
    "darwin-aarch64": { "url": "<same>", "signature": "<same>" }
  }
}
```

- Each `url` is downloaded and installed, which is safe only because of the
  signature: the app checks the file's minisign signature against the public
  key built into it (`plugins.updater.pubkey` in
  `shell/src-tauri/tauri.conf.json`, key id `E8DAB79E2EB1D6C4`) and, with
  `requireSignedVersion`, that it was signed for `version`. A tampered
  document can at most make the update fail, and the app then opens mxml.sh.
  The release checks the same two things before publishing
  (`scripts/verify-updater-signature.ts`).
- Only the check must avoid github.com; the files themselves are GitHub
  release assets.
- Each platform is listed under `<os>-<arch>-<installer>` and `<os>-<arch>`,
  the two names the plugin looks up, most specific first.
- The app picks the channel from its own version (`X.Y.Z` is `stable`,
  `X.Y.Z-rc.N` is `rc`), matching the channel the release writes.
- Unlike the version manifest it is fetched only when the user clicks
  "Update to X.Y.Z", so it has no conditional-request logic. It can trail
  the version manifest by the CDN's `max-age`; an update that isn't listed
  yet fails over to mxml.sh.
- A platform is listed only when the release carries its signature
  (`<setup>.exe.sig` from `windows-shell`, `<name>.app.tar.gz.sig` from
  `stuffbucket/macos-builder`), and the file is written only when at least
  one is.

## Hosting & write path

- The manifest is served at `/updates/manifest.json` on GitHub Pages
  (`https://mxml.sh/updates/manifest.json`, the Pages custom domain; the
  `stuffbucket.github.io/maximal/` path redirects there). The desktop client
  fetches it with a 6 h cache TTL and fails closed on any error. Each refetch
  is conditional: it sends back the `ETag` exactly as received (weak `W/` for
  a gzip response) and `Last-Modified`, and a 304 reuses the held body. It
  also sends `Cache-Control: no-cache` so intermediate proxies revalidate.
  Neither that header nor a query string bypasses the CDN's own `max-age`,
  so the client adds no cache-busting query.
- The source-of-truth file is the committed
  `site/public/updates/manifest.json`. Astro serves `site/public/**`
  verbatim, and a public file wins over the fallback route
  `site/src/pages/updates/manifest.json.ts` (which re-emits the same
  committed manifest if the file were ever absent).
- **The generated manifest PR is the only repository write path.** After a
  release publishes, release.yml's `manifest` job runs
  `scripts/write-updates-manifest.ts --tag <tag>` (read-modify-write, so a
  beta publish never clobbers `stable` and vice versa; it also writes
  `desktop/<channel>.json` when the release has a signed desktop
  update) on the rolling
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
