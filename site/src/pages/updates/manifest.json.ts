// The update manifest the desktop app polls to learn the latest version.
// Prerendered to dist/updates/manifest.json at build time and served (static,
// Fastly-CDN-cached, no auth, no rate limit) at both:
//   https://mxml.sh/updates/manifest.json                        ← app fetches this
//   https://stuffbucket.github.io/maximal/updates/manifest.json  (301-redirects here)
// mxml.sh is now a GitHub Pages custom domain (Fastly-CDN-cached), so the app
// polls it directly — fewest hops / smallest trust surface. It's also the
// human-facing download link.
//
// FALLBACK, not the primary writer (issue #220, phase 1). The release workflow
// writes site/public/updates/manifest.json at publish time via
// scripts/write-updates-manifest.ts — fed the release's OWN tag + assets, so it
// names its own tag and is fresh-on-publish (no `releases/latest` propagation
// lag). Astro serves site/public/** verbatim and SKIPS this route when that
// file exists (a public file wins a same-path collision), so once a release has
// committed the manifest, the release-authored copy is what ships. This route
// still generates the manifest when the public file is absent (first-ever
// build / migration), so the site always has a manifest. Both mechanisms reuse
// the SAME pure buildManifest below — one source of truth for the schema.
//
// Shape — channel-keyed and schema-versioned so adding a `nightly` channel
// later is a server-only, non-breaking change. `beta` is omitted when no
// prerelease exists. Schema 2 adds a per-channel `tag` and a keyed `downloads`
// map; see site/src/lib/updates-manifest.ts for the full contract. The bump is
// additive — schema-1 desktop clients keep reading `channels.stable.version`
// byte-for-byte unchanged.
//
// SECURITY: the `downloads` map is BROWSER-ONLY. The desktop client
// (src/lib/update-check.ts) must read ONLY `version` and keep DOWNLOAD_URL a
// hardcoded mxml.sh constant, so a tampered manifest can at most misreport a
// version — never redirect a download. Do NOT wire the installer to
// downloads.url. `notes` is a display-only link to the GitHub release.
//
// FALLBACK-ONLY as of #223: the primary manifest is the committed
// site/public/updates/manifest.json (Astro serves public/** verbatim and a
// public file wins a same-path collision, so this route is skipped when that
// file exists — which it always does in the repo). This route now re-emits from
// that SAME committed manifest (resolveLatestRelease reads it), so if the public
// file were ever removed the route regenerates a byte-equivalent document. No
// GitHub API, no GITHUB_TOKEN, no SITE_PIN. An absent channel emits empty
// channels, so the desktop client reads "unknown" / no update.

import { buildManifest } from "../../lib/updates-manifest";
import {
  resolveLatestPrerelease,
  resolveLatestRelease,
} from "../../lib/version";

export const prerender = true;

export function GET(): Response {
  const stable = resolveLatestRelease();
  const beta = resolveLatestPrerelease();

  const manifest = buildManifest({
    stable:
      stable.hasRelease && stable.tag
        ? { tag: stable.tag, assets: stable.assets }
        : null,
    beta:
      beta.hasRelease && beta.tag
        ? { tag: beta.tag, assets: beta.assets }
        : null,
  });

  return new Response(`${JSON.stringify(manifest, null, 2)}\n`, {
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
