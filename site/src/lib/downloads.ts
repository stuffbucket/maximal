// Single build-time source of the release/download data the landing components
// render. Wraps lib/version.ts (the unchanged release-resolution + fail-closed
// logic) and memoizes it so Hero + Downloads share one lookup instead of each
// hitting the GitHub API. Markdoc tag attributes don't receive `$variables`, so
// the components await this directly rather than taking the data as props.

import { resolveLatestRelease } from "./version";

const REPO = "stuffbucket/maximal";
const REPO_URL = `https://github.com/${REPO}`;
const RELEASES_URL = `${REPO_URL}/releases`;

export interface DownloadInfo {
  repo: string;
  repoUrl: string;
  releasesUrl: string;
  /** Direct .dmg URL when a release exists, else the releases listing. */
  macDmg: string;
  macDmgFile: string;
  /** Direct Windows installer URL when the release ships a *-setup.exe, else null. */
  winSetup: string | null;
  winSetupFile: string | null;
  /** True when the release carries a Windows *-setup.exe artifact. */
  hasWindows: boolean;
  /** Human label, e.g. "v0.4.32" or "see /releases". */
  versionLabel: string;
  tag: string | null;
  hasRelease: boolean;
}

let cached: Promise<DownloadInfo> | undefined;

export function getDownloadInfo(): Promise<DownloadInfo> {
  cached ??= compute();
  return cached;
}

async function compute(): Promise<DownloadInfo> {
  const { tag, hasRelease, assets } = await resolveLatestRelease();
  const assetUrl = (filename: string): string =>
    hasRelease && tag
      ? `${REPO_URL}/releases/download/${tag}/${filename}`
      : RELEASES_URL;
  const versionForAsset = tag ?? "latest";
  const conventionDmg = `maximal-${versionForAsset}-darwin-arm64.dmg`;

  // Resolve both downloads from the release's actual asset list rather than
  // guessing filenames, so each button links to the real artifact for the
  // latest build. macOS prefers an arm64 .dmg; Windows takes the NSIS
  // *-setup.exe. A pinned version carries no asset list, so macOS falls back to
  // the conventional .dmg filename and Windows stays "coming soon".
  const macAsset =
    assets.find((a) => /\.dmg$/i.test(a.name) && /arm64|aarch64/i.test(a.name)) ??
    assets.find((a) => /\.dmg$/i.test(a.name)) ??
    null;
  const winAsset = assets.find((a) => /-setup\.exe$/i.test(a.name)) ?? null;

  return {
    repo: REPO,
    repoUrl: REPO_URL,
    releasesUrl: RELEASES_URL,
    macDmg: macAsset?.url ?? assetUrl(conventionDmg),
    macDmgFile: macAsset?.name ?? conventionDmg,
    winSetup: winAsset?.url ?? null,
    winSetupFile: winAsset?.name ?? null,
    hasWindows: winAsset !== null,
    versionLabel: hasRelease && tag ? tag : "see /releases",
    tag,
    hasRelease,
  };
}
