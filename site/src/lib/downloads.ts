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
  const { tag, hasRelease } = await resolveLatestRelease();
  const assetUrl = (filename: string): string =>
    hasRelease && tag
      ? `${REPO_URL}/releases/download/${tag}/${filename}`
      : RELEASES_URL;
  const versionForAsset = tag ?? "latest";
  const macDmgFile = `maximal-${versionForAsset}-darwin-arm64.dmg`;
  return {
    repo: REPO,
    repoUrl: REPO_URL,
    releasesUrl: RELEASES_URL,
    macDmg: assetUrl(macDmgFile),
    macDmgFile,
    versionLabel: hasRelease && tag ? tag : "see /releases",
    tag,
    hasRelease,
  };
}
