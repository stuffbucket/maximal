// Build-time GitHub star count for the "Star on GitHub" widget.
//
// Unlike the release/version data (lib/version.ts), which is deliberately baked
// from a committed manifest so the build stays deterministic + offline, the star
// count is a soft, decorative number: it's allowed to be fetched at build time
// and it's allowed to be missing. This module fetches `stargazers_count` from
// the GitHub REST API once per build, memoized, and NEVER throws — a failed or
// slow request resolves to `null` so the page always builds (offline CI, rate
// limit, DNS, timeout). The component renders a countless "Star on GitHub" pill
// in that case, and a tiny client-side refresh (in StarButton.astro) fills the
// count in the browser as a fallback and keeps it live between rebuilds.

const REPO = "stuffbucket/maximal";
const API_URL = `https://api.github.com/repos/${REPO}`;

// Keep the build snappy and never let a hung request stall it.
const FETCH_TIMEOUT_MS = 3000;

let cached: Promise<number | null> | undefined;

/** Star count for the repo, or `null` when it can't be resolved at build time.
 *  Memoized for the whole build; safe to await from multiple components. */
export function getStarCount(): Promise<number | null> {
  cached ??= fetchStarCount();
  return cached;
}

async function fetchStarCount(): Promise<number | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(API_URL, {
      signal: controller.signal,
      headers: {
        // GitHub's API 403s requests without a User-Agent.
        "User-Agent": "maximal-site-build",
        Accept: "application/vnd.github+json",
      },
    });
    if (!res.ok) return null;
    const data: unknown = await res.json();
    const count = (data as { stargazers_count?: unknown })?.stargazers_count;
    return typeof count === "number" && Number.isFinite(count) ? count : null;
  } catch {
    // Offline build, timeout, rate limit, bad JSON — all resolve to "no count".
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Compact, GitHub-style count label: 1234 → "1.2k", 999 → "999". Exported so
 *  the build-time render and the client refresh format identically. */
export function formatStarCount(n: number): string {
  if (n < 1000) return String(n);
  const k = n / 1000;
  // One decimal below 10k (1.2k), whole thousands above (12k) — matches GitHub.
  const label = k < 10 ? k.toFixed(1).replace(/\.0$/, "") : Math.round(k).toString();
  return `${label}k`;
}
