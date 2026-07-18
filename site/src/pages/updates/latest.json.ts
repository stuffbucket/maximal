// The Tauri v2 update manifest the desktop app's IN-PLACE self-updater polls.
// Prerendered to dist/updates/latest.json at build time and served (static,
// Fastly-CDN-cached, no auth) at:
//   https://mxml.sh/updates/latest.json          ← the updater plugin fetches this
// (tauri.conf.json → plugins.updater.endpoints). It sits NEXT TO the notify-only
// manifest.json this same `astro build` emits (pages/updates/manifest.json.ts).
//
// WHY this route fetches the GitHub API (unlike manifest.json.ts, which reads the
// committed static manifest): the Tauri contract needs TWO things the committed
// manifest does not carry — the `.app.tar.gz` updater bundle URL and, critically,
// the FULL TEXT of its detached `.app.tar.gz.sig` signature. The committed
// manifest only lists the browser-facing `.dmg`/`.msi`/… download slots. So we
// resolve the release's real asset list AND fetch the `.sig` body here, at build
// time, and inline the signature. This mirrors the site's historical build-time
// releases lookup: authenticate with GITHUB_TOKEN, and FAIL CLOSED.
//
// FAIL CLOSED — a `latest.json` with a wrong `url` or an empty/placeholder
// `signature` would make EVERY client's updater fail signature verification. So:
//   - No updater artifact yet (true until the macos-builder ships it) ⇒ we
//     return an EMPTY-body 404. Astro then does NOT write dist/updates/latest.json
//     at all (an empty response body skips file creation), so no bad file ships.
//   - The releases API erroring (403 rate-limit / 5xx) THROWS ⇒ the build fails
//     and the last good deploy (and its last good latest.json) stays live, rather
//     than being replaced by a broken one.
// The pure shape lives in site/src/lib/tauri-updater-manifest.ts (unit-tested).

import {
  buildUpdaterManifest,
  resolveUpdaterArtifact,
  serializeUpdaterManifest,
  type UpdaterAsset,
} from "../../lib/tauri-updater-manifest";

export const prerender = true;

const REPO = "stuffbucket/maximal";

/** Build-time GitHub API auth + cache-busting, mirroring the site's historical
 *  releases lookup. GITHUB_TOKEN is passed by deploy-pages.yml; it must never
 *  reach the client bundle (this route runs in the Node build context only). */
function githubHeaders(): Record<string, string> {
  const token = (process.env.GITHUB_TOKEN ?? "").trim();
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "maximal-site-build",
    "X-GitHub-Api-Version": "2022-11-28",
    // The releases API is CDN-cached; force revalidation so a deploy fired
    // minutes after a publish sees the just-attached updater assets.
    "Cache-Control": "no-cache",
    Pragma: "no-cache",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

function parseAssets(raw: unknown): UpdaterAsset[] {
  if (!Array.isArray(raw)) return [];
  const out: UpdaterAsset[] = [];
  for (const item of raw) {
    const asset = item as { name?: unknown; browser_download_url?: unknown };
    if (
      typeof asset.name === "string" &&
      typeof asset.browser_download_url === "string"
    ) {
      out.push({ name: asset.name, url: asset.browser_download_url });
    }
  }
  return out;
}

/** Resolve the latest published release's tag + asset list, or null when there
 *  is no published release yet (a legitimate first-launch state). Non-404
 *  failures THROW to fail the build closed. */
async function fetchLatestRelease(): Promise<{
  tag: string;
  assets: UpdaterAsset[];
} | null> {
  const url = `https://api.github.com/repos/${REPO}/releases/latest?_cb=${Date.now()}`;
  const res = await fetch(url, { headers: githubHeaders() });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(
      `GitHub releases API returned ${res.status} ${res.statusText} — refusing to deploy a latest.json without a verifiable updater artifact. Re-run once the API recovers.`,
    );
  }
  const body = (await res.json()) as { tag_name?: unknown; assets?: unknown };
  if (typeof body.tag_name !== "string" || body.tag_name.length === 0) {
    throw new Error("GitHub releases API response missing tag_name");
  }
  return { tag: body.tag_name, assets: parseAssets(body.assets) };
}

/** Fetch the FULL TEXT of the detached signature asset. Returns null when the
 *  body is missing/empty so the caller fails closed. A non-404 error THROWS. */
async function fetchSignature(asset: UpdaterAsset): Promise<string | null> {
  const res = await fetch(asset.url, { headers: githubHeaders() });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(
      `Fetching updater signature ${asset.name} returned ${res.status} ${res.statusText} — refusing to deploy an unverifiable latest.json.`,
    );
  }
  const text = (await res.text()).trim();
  return text.length > 0 ? text : null;
}

/** An empty-body 404: Astro's static build skips writing the output file when
 *  the response body is empty, so returning this emits NO latest.json — the
 *  fail-closed "nothing rather than a broken manifest" outcome. */
function noManifest(): Response {
  return new Response(null, { status: 404 });
}

export async function GET(): Promise<Response> {
  const release = await fetchLatestRelease();
  if (!release) return noManifest();

  const artifact = await resolveUpdaterArtifact(release.assets, fetchSignature);
  if (!artifact) return noManifest();

  const manifest = buildUpdaterManifest({ tag: release.tag, artifact });
  // Defensive: buildUpdaterManifest also fails closed (null) on an empty
  // signature, so a bad document can never be serialized here.
  if (!manifest) return noManifest();

  return new Response(serializeUpdaterManifest(manifest), {
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
