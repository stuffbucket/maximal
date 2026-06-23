// Build-time release resolution, shared by the landing page (index.astro) and
// the update manifest (pages/updates/manifest.json.ts) so the version they
// advertise can never drift apart. Runs in the Node build context only — it
// reads process.env.GITHUB_TOKEN, which must never reach the client bundle.

const REPO = "stuffbucket/maximal";

export interface ReleaseInfo {
  /** The latest release tag, e.g. "v0.4.32", or null when no release exists. */
  tag: string | null;
  hasRelease: boolean;
}

function githubHeaders(): Record<string, string> {
  // Authenticate with the build's GITHUB_TOKEN (deploy-pages.yml passes it).
  // The anonymous API is 60 req/hr per IP, shared across Actions runners — a
  // busy release day exhausts it, and an unauthenticated 403 used to silently
  // fall back to "no version" with no download links. Authenticated is 1,000+/hr.
  const token = (process.env.GITHUB_TOKEN ?? "").trim();
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "maximal-site-build",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function fetchGitHubReleaseJson(path: string): Promise<unknown | null> {
  const res = await fetch(`https://api.github.com/repos/${REPO}/${path}`, {
    headers: githubHeaders(),
  });
  // 404 is the *legitimate* "no published release yet" state (first launch) —
  // resolve to "no release" without failing the build.
  if (res.status === 404) return null;
  // Anything else (403 rate-limit, 5xx, malformed body) is a real failure.
  // FAIL THE BUILD rather than fall open: a thrown error keeps the last good
  // site (and its last good manifest) live instead of replacing them with a
  // version-less deploy.
  if (!res.ok) {
    throw new Error(
      `GitHub releases API returned ${res.status} ${res.statusText} — refusing to deploy a site without download links. Re-run once the API recovers.`,
    );
  }
  return res.json();
}

async function fetchLatestTag(): Promise<ReleaseInfo> {
  const body = await fetchGitHubReleaseJson("releases/latest");
  if (!body) return { tag: null, hasRelease: false };
  const release = body as { tag_name?: string };
  if (typeof release.tag_name === "string" && release.tag_name.length > 0) {
    return { tag: release.tag_name, hasRelease: true };
  }
  throw new Error("GitHub releases API response missing tag_name");
}

async function fetchLatestPrereleaseTag(): Promise<ReleaseInfo> {
  const body = await fetchGitHubReleaseJson("releases?per_page=100");
  if (!body) return { tag: null, hasRelease: false };
  if (!Array.isArray(body)) {
    throw new Error("GitHub releases API response was not a release list");
  }

  const release = body.find(
    (item): item is { tag_name: string } => {
      const release = item as {
        tag_name?: unknown;
        prerelease?: unknown;
        draft?: unknown;
      };
      return (
        typeof release.tag_name === "string" &&
        release.prerelease === true &&
        release.draft === false
      );
    },
  );
  if (!release) return { tag: null, hasRelease: false };
  return { tag: release.tag_name, hasRelease: true };
}

/**
 * Resolve the release to advertise. A `VITE_SITE_PIN_VERSION` pin (surfaced
 * from the SITE_PIN_VERSION repo variable by deploy-pages.yml) wins over the
 * live lookup, letting us cut and validate a release without the site
 * advancing to it. Otherwise track GitHub's latest non-prerelease, non-draft
 * release.
 */
export async function resolveLatestRelease(): Promise<ReleaseInfo> {
  const pinned = (import.meta.env.VITE_SITE_PIN_VERSION ?? "").trim();
  if (pinned) return { tag: pinned, hasRelease: true };
  return fetchLatestTag();
}

export async function resolveLatestPrerelease(): Promise<ReleaseInfo> {
  return fetchLatestPrereleaseTag();
}
