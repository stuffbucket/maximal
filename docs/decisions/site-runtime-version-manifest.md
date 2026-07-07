# Design: decouple the marketing site from releases via a runtime version manifest

**Status:** Proposal for review. Design only — nothing implemented.
**Date:** 2026-07-03.
**Authors:** consolidated from a parallel investigation (root-cause, data-contract, CI/workflow).

## Problem statement

Two entangled issues, one root cause:

1. **Failing Pages deploys.** The "Deploy to GitHub Pages" workflow intermittently
   fails with `Deployment failed, try again later` (~18%: 7 of the last 40 runs,
   **all** on a single high-commit day; quiet days ≈ 0 failures).
2. **A release requires a full site rebuild+redeploy** to advertise its new
   version and download links, which is fragile (a `releases/latest`
   propagation race, band-aided by a ~5-minute poll-gate added in PR #187).

### Root cause (evidence-backed)

- **The deploy failures are NOT a concurrency race.** All deploys funnel through
  the single `deploy-pages.yml` (`concurrency: group: "pages"`), which serializes
  them correctly. Decisive evidence: the first v0.4.39 failure (19:35 UTC) had
  **zero** other deploys running (the prior batch finished 6 minutes earlier). A
  solo failure cannot be a collision. Overlap does not predict failure — a trio of
  deploys seconds apart all *succeeded*, while a serialized pair both *failed*.
  The errors were originally attributed to **GitHub Pages backend flakiness**,
  amplified by deploy **volume**. *(Correction, 2026-07-06, issue #239: a
  significant and **repo-fixable** contributor is the re-run artifact-accumulation
  trap — `actions/deploy-pages` refuses to deploy a run with >1 artifact named
  `github-pages`, and re-running the failed deploy job re-uploads a second copy
  without removing the first, so the count climbs 1→2→3 and every re-run fails
  harder. Fixed in `deploy-pages.yml` by deleting any stale artifact before upload;
  operationally, re-run Pages deploys with a fresh `workflow_dispatch`, never by
  re-running failed jobs.)*
- **Volume amplifier #1:** `deploy-pages.yml`'s `push: [main]` trigger has **no
  `paths:` filter**, so the site fully rebuilds+redeploys on *every* main commit —
  even commits that never touch `site/` (verified against 4 recent commits). Busy
  days multiply deploys, which multiplies the odds of hitting the re-run
  artifact trap above (and any residual backend flakiness).
- **Volume amplifier #2:** the site **bakes the version at build time**
  (`site/src/lib/version.ts` fetches `releases/latest` during SSG; `Hero.astro` /
  `GetStarted.astro` bake the hrefs into static HTML). So every release *must*
  redeploy the site, bunching against the release merge commit's own push-deploy.
- **Dead-code artifact:** PR #187's "Wait for releases/latest" gate is
  `if: github.event_name == 'release'`, but that event **never fires** for our
  token-created releases (an anti-loop guard suppresses it — which is *why* the
  `redeploy-site` job dispatches the deploy instead). So the propagation-race
  guard never runs on the real release path.

## Best practice (the target design)

Mature updater ecosystems (Sparkle `appcast`, Squirrel/Electron `latest.yml`,
Tauri `latest.json`, VS Code update service) all converge on one pattern:

> **The release process writes a small, static manifest to a fixed, self-hosted
> CDN URL. Every consumer (website, desktop updater, install script) reads *that
> file* at runtime. Nobody queries the source-of-truth API (GitHub) from the
> client.**

Two hard-won properties this preserves:

- **No unauthenticated GitHub API calls from the browser.** The GitHub REST API
  is 60 req/hr/IP unauthenticated; a browser can't ship a token, so visitors
  would share that limit → 403s → a link-less page. Fetching a **static object**
  at a known URL is not API-rate-limited. *(This is why a GitHub **release asset**
  is the wrong host: discovering the asset URL from the browser requires the API.
  A fixed Pages path does not.)*
- **Fail-closed.** A baked fallback href in the initial HTML keeps a working
  download for no-JS, crawlers, and manifest-fetch failures.

Critically, the manifest **names its own tag**, so the `releases/latest`
propagation lag (the thing #187 band-aids) is designed out — the lagging question
is never asked.

**We already do this correctly for the desktop app.** `src/lib/update-check.ts`
fetches `https://stuffbucket.github.io/maximal/updates/manifest.json` at runtime
(no auth, no rate limit, fail-closed, 6h TTL). Only the **marketing site**
regressed from the pattern by baking at build time. The fix is to make the site
do what the updater already does.

## The data contract

Extend the existing `manifest.json` (currently emitted by
`site/src/pages/updates/manifest.json.ts`) to `schema: 2`. Additive: schema-1
desktop clients in the field keep working — they read only
`channels.stable.version`, which is unchanged.

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

Design decisions:

- **`channels` is a map keyed by channel name.** `beta`/`nightly` are
  representable with the identical object shape; the site UX reads only `stable`.
  Adding a stream is a server-side write, no schema change. The desktop client
  already keys by `BUILD_CHANNEL`, so a beta binary already reads `channels.beta`
  with zero change. **This makes multiple release streams first-class in the data
  model with no UX work now** — matching the stated scope ("design for it, don't
  build the UX yet").
- **`downloads` is a keyed map, not an array** — slot keys (`macos-arm64-dmg`,
  `windows-x64-setup`, room for `windows-x64-msi`, `windows-x64-zip`,
  `windows-install-ps1`, `macos-x64-dmg`) let the site pick a specific artifact
  without name-sniffing and let us add artifacts without breaking readers. An
  absent key ⇒ site renders "coming soon" (same signal as today's `hasWindows:false`).
- **Security property preserved.** The desktop client must continue to read
  **only** `version` (`DOWNLOAD_URL` stays a hardcoded `mxml.sh` constant). A
  tampered manifest can then at most misreport a version — never redirect a
  download. `downloads` exists purely for the browser, where the URL is
  user-visible and clickable anyway (no new trust surface). This must be
  documented so nobody later wires the installer to `downloads.url`.

## Hosting & write mechanism

**Keep the manifest at `/updates/manifest.json` on GitHub Pages** (Fastly CDN) —
the desktop client already trusts that URL and it is already CDN-served /
no-auth / no-rate-limit. Change only *how it's written*: the release must publish
the JSON to that path **without running the Astro build**. Because Astro serves
`site/public/**` verbatim, placing the file at `site/public/updates/manifest.json`
means ordinary builds still emit it (migration fallback) while a release can
update it via a lightweight file write/sync. Cache the manifest with a short TTL
(≈60–300s) so a release propagates quickly; the binaries it points at keep
long/immutable caching (mutable pointer, immutable targets).

*(Rejected: hosting as a GitHub release asset — the browser would need the GitHub
API to discover the asset URL, reintroducing the rate limit. Rejected: a brand-new
path — needless; the existing URL already has the right properties.)*

## Consumer changes

**Site (`Hero.astro`, `GetStarted.astro`, `downloads.ts`):** switch from
"resolve at build" to "bake a fallback, hydrate at runtime":

1. Bake a **release-independent** fallback href (`/releases`) + generic label into
   the initial HTML — covers no-JS, crawlers, and fetch failures (fail-closed).
   This removes the build's dependency on `GITHUB_TOKEN` / the GitHub API.
2. A small inline script `fetch`es `${BASE_URL}/updates/manifest.json`, reads
   `channels.stable.downloads`, and rewrites the anchors' `href` + the version
   pill. The GetStarted buttons already carry `data-os` hooks; add matching hooks
   to Hero's anchors.
3. Fetch failure / malformed JSON ⇒ do nothing (keep the baked fallback).
4. Same-origin fetch (Pages serves both) ⇒ no CORS. SEO/first-paint covered by
   the baked fallback href.

**Desktop upgrade check (`src/lib/update-check.ts`):** **zero change required.**
A `schema: 2` doc with the same `channels.stable.version` satisfies
`parseManifestVersion` byte-for-byte; the added `tag`/`downloads` fields are
ignored. Do **not** point the client at `downloads.url`.

## Workflow simplification

**Deletions:** the `release: published` trigger (dead), the `redeploy-site` job
(release.yml), the #187 poll-gate step, the build-time `GITHUB_TOKEN` /
`releases/latest` lookup, the top-level `actions: write` permission (verified used
only by `redeploy-site`), and — pending confirmation — the whole `site-pin.yml`
workflow (pinning becomes a manifest-data concern).

**Additions:** a `paths:` filter on the `push` trigger (`site/**` +
`.github/workflows/deploy-pages.yml`); `cancel-in-progress: true` (safe once the
deploy no longer carries release-critical state — structurally guarantees ≤1
environment deploy in flight, eliminating the backend-collision window rather than
retrying into it); and one small "write manifest.json" step on release
(read-modify-write so a beta publish never clobbers `stable`, and vice-versa).

**Net:** live deploy paths drop **3 → 1**; several triggers/jobs/steps and one
permission removed; the `releases/latest` race designed out. Complexity decreases.

*Belt-and-suspenders:* to the extent the backend is *also* intermittently flaky
(now known to be a smaller factor than the re-run artifact trap addressed in
issue #239), a lightweight retry around `actions/deploy-pages` is worth adding as
a secondary guard, but `cancel-in-progress: true` + far fewer deploys is the
primary fix.

## Phased migration (never delete the old path before the new one works)

- **Phase 0 — richer manifest (safe, invisible).** Bump `manifest.json.ts` to
  `schema: 2` with `downloads` (derived from assets it already resolves). Desktop
  client unaffected; site still builds as today.
- **Phase 1 — release writes the manifest without an Astro rebuild.** Add the
  release-workflow write step so the manifest is fresh-on-release regardless of
  site rebuilds. Keep the build-time generator as a fallback. **Both paths now
  run** (belt-and-suspenders).
- **Phase 2 — site hydrates at runtime.** Change Hero/GetStarted to the
  fallback-href + runtime-fetch pattern. Verify with a browser smoke artifact
  (JS on → direct dmg + version pill; JS off → `/releases` link).
- **Phase 3 — decouple deploys & delete dead code.** Add the `paths:` filter,
  drop the `release: published` trigger, delete the #187 poll-gate and the
  build-time `GITHUB_TOKEN` lookup, flip `cancel-in-progress: true`, delete the
  `redeploy-site` job and `actions: write`. Cut a real release; confirm it
  advertises the new version to both the site and the app poller with **no** Pages
  deploy triggered by the release.
- **Phase 4 (optional cleanup) — DONE (#223).** Retired `site-pin.yml` +
  `VITE_SITE_PIN_VERSION` / `SITE_PIN_VERSION` and the build-time
  `GITHUB_TOKEN` / `releases/latest` lookup. Pinning is now folded into manifest
  generation exactly as recommended below: `site/src/lib/version.ts` reads the
  **committed static** `site/public/updates/manifest.json` (imported at build
  time, no API), so the server-rendered fail-closed fallback still bakes a real
  version + direct download links. release.yml's `manifest` job keeps that file
  fresh on every publish, so "the pin" is now just what the manifest advertises.

**Ordering guarantee:** the release-advertising path (manifest write, Phase 1) is
proven live *before* the old path (`redeploy-site`, Phase 3) is removed — so
there's never a window where a release fails to advertise its version.

## Open decisions for the reviewer

1. **Keep `SITE_PIN_VERSION`?** With runtime hydration, "pinning" becomes "what
   the manifest advertises." Recommendation: fold pinning into manifest
   generation and retire the build-time pin — but this is a product call.
   **RESOLVED (#223):** retired. Pinning is now a manifest-data concern — the
   build reads the committed static `site/public/updates/manifest.json`, and to
   pin the site you edit/commit that file (or let a release's `manifest` job
   write it). `site-pin.yml` + `SITE_PIN_VERSION` + the build-time GitHub-API
   lookup are gone.
2. **Quick-win now vs. coherent rollout?** The `paths:` filter + retry alone would
   cut most failures immediately, independent of the manifest work. But it edits
   `deploy-pages.yml` twice (now, then again in Phase 3). Recommendation: land the
   phased plan coherently unless the red is actively blocking.

## Affected files (reference)

- `site/src/lib/version.ts`, `site/src/lib/downloads.ts`
- `site/src/pages/updates/manifest.json.ts`
- `site/src/components/markdoc/Hero.astro`, `site/src/components/markdoc/GetStarted.astro`
- `src/lib/update-check.ts` (consumer — no change; contract reference)
- `.github/workflows/deploy-pages.yml` (paths filter, poll-gate + token removal, concurrency flip)
- `.github/workflows/release.yml` (`redeploy-site` removal, manifest-write step, `actions: write` removal)
- `.github/workflows/site-pin.yml` (removed in #223)
