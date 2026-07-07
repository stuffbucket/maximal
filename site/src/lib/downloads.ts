// Single build-time source of the release/download data the landing components
// render. Wraps lib/version.ts (which now reads the committed static manifest —
// no GitHub API) and memoizes it so Hero + Downloads share one lookup. Markdoc
// tag attributes don't receive `$variables`, so the components await this
// directly rather than taking the data as props.

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
  const { tag, hasRelease, assets } = resolveLatestRelease();
  const assetUrl = (filename: string): string =>
    hasRelease && tag
      ? `${REPO_URL}/releases/download/${tag}/${filename}`
      : RELEASES_URL;
  const versionForAsset = tag ?? "latest";
  const conventionDmg = `maximal-${versionForAsset}-darwin-arm64.dmg`;

  // Resolve both downloads from the manifest channel's actual asset list rather
  // than guessing filenames, so each button links to the real artifact for the
  // advertised build. macOS prefers an arm64 .dmg; Windows takes the NSIS
  // *-setup.exe. When the manifest carries no channel (no release yet), macOS
  // falls back to the conventional .dmg filename and Windows stays "coming
  // soon" — and the release-independent /releases fallback covers the rest.
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
