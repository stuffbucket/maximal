// The update manifest the desktop app polls to learn the latest version.
// Prerendered to dist/updates/manifest.json at build time and served (static,
// Fastly-CDN-cached, no auth, no rate limit) at both:
//   https://stuffbucket.github.io/maximal/updates/manifest.json  ← app fetches this
//   https://mxml.sh/maximal/updates/manifest.json                (via Caddy proxy)
// The app polls the Pages origin directly (fewest hops / smallest trust
// surface); mxml.sh stays the human-facing download link.
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
// Fail-closed: resolveLatestRelease() throws on a real API failure, failing the
// build and keeping the last-good manifest live rather than publishing a
// version-less one. A genuine "no release yet" (404) emits empty channels, so
// the client reads "unknown" / no update.

import { buildManifest } from "../../lib/updates-manifest";
import {
  resolveLatestPrerelease,
  resolveLatestRelease,
} from "../../lib/version";

export const prerender = true;

export async function GET(): Promise<Response> {
  const [stable, beta] = await Promise.all([
    resolveLatestRelease(),
    resolveLatestPrerelease(),
  ]);

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
