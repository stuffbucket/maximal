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
// prerelease exists:
//   { "schema": 1, "generated": "<iso>",
//     "channels": { "stable": { ... }, "beta": { ... } } }
//
// Deliberately carries NO download URL. The client pins its download
// destination as a compile-time constant (see src/lib/update-check.ts →
// DOWNLOAD_URL), so a tampered manifest can at most misreport a version — it
// can never redirect a user to a malicious download. `notes` is a display-only
// link to the GitHub release.
//
// Fail-closed: resolveLatestRelease() throws on a real API failure, failing the
// build and keeping the last-good manifest live rather than publishing a
// version-less one. A genuine "no release yet" (404) emits empty channels, so
// the client reads "unknown" / no update.

import {
  resolveLatestPrerelease,
  resolveLatestRelease,
} from "../../lib/version";

export const prerender = true;

const REPO_URL = "https://github.com/stuffbucket/maximal";

export async function GET(): Promise<Response> {
  const [{ tag, hasRelease }, beta] = await Promise.all([
    resolveLatestRelease(),
    resolveLatestPrerelease(),
  ]);

  const channels: Record<string, { version: string; notes: string }> = {};
  if (hasRelease && tag) {
    channels.stable = {
      version: tag.replace(/^v/, ""),
      notes: `${REPO_URL}/releases/tag/${tag}`,
    };
  }
  if (beta.hasRelease && beta.tag) {
    channels.beta = {
      version: beta.tag.replace(/^v/, ""),
      notes: `${REPO_URL}/releases/tag/${beta.tag}`,
    };
  }

  const manifest = {
    schema: 1,
    generated: new Date().toISOString(),
    channels,
  };

  return new Response(`${JSON.stringify(manifest, null, 2)}\n`, {
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
