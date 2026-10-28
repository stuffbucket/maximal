// Schema + pure builder for the update manifest the project publishes at the
// canonical, CDN-cached, no-auth URL:
//   https://stuffbucket.github.io/maximal/updates/manifest.json
//
// Two independent consumers read this file at runtime:
//   1. The desktop updater (src/lib/update/update-check.ts → parseManifestVersion),
//      which reads ONLY `channels.<channel>.version`. It never reads a download
//      URL — the app pins its download destination as a compile-time constant
//      (DOWNLOAD_URL), so a tampered manifest can at most misreport a version,
//      never redirect a download.
//   2. The marketing site (browser), which reads `channels.stable.downloads` to
//      hydrate the download buttons. Those URLs are user-visible + clickable, so
//      they add no new trust surface — see the SECURITY note below.
//
// SECURITY INVARIANT — `downloads` is BROWSER-ONLY. Do NOT wire the desktop
// installer (or any auto-update flow) to `downloads.<slot>.url`. The desktop
// side must keep reading only `version`; the URL it sends users to stays the
// hardcoded `mxml.sh` constant in src/lib/update/update-check.ts. The Windows
// app's in-place updater reads a separate, signature-checked document — see
// "Desktop updater manifest" at the end of this file.
//
// SCHEMA HISTORY
//   schema 1: { version, notes } per channel — desktop clients in the field.
//   schema 2: adds per-channel `tag` and a keyed `downloads` map. Purely
//             ADDITIVE: `channels.<channel>.version` is byte-for-byte
//             unchanged, so a schema-1 client parsing a schema-2 document reads
//             the same version and ignores the new fields. No migration needed.

/** The current on-disk manifest schema version. */
export const MANIFEST_SCHEMA_VERSION = 2 as const;

/** A single downloadable artifact for a channel. The map key (a stable "slot",
 *  e.g. `macos-arm64-dmg`) identifies the artifact by role, so a reader picks a
 *  specific download without name-sniffing and new slots can be added without
 *  breaking existing readers. */
export interface ManifestDownload {
  /** Asset filename, e.g. "maximal-v0.4.39-darwin-arm64.dmg". */
  name: string;
  /** Direct browser download URL. BROWSER-ONLY — see the SECURITY note above. */
  url: string;
}

/** Stable slot keys for the `downloads` map. New slots (e.g. `windows-x64-msi`,
 *  `windows-x64-zip`, `windows-install-ps1`, `macos-x64-dmg`) can be added here
 *  without a schema bump — an absent slot simply means "not offered", which a
 *  reader renders as "coming soon". */
export type DownloadSlot =
  | "macos-arm64-dmg"
  | "macos-x64-dmg"
  | "windows-x64-setup"
  | "windows-x64-msi"
  | "windows-x64-zip"
  | "windows-install-ps1";

export interface ManifestChannel {
  /** Release version, no leading "v" (e.g. "0.4.39"). The ONLY field the
   *  desktop updater reads. */
  version: string;
  /** The release tag the channel names (e.g. "v0.4.39"). Present in schema 2 so
   *  the manifest names its own tag and the `releases/latest` propagation race
   *  is designed out. */
  tag: string;
  /** Display-only link to the GitHub release. */
  notes: string;
  /** Keyed map of downloadable artifacts. BROWSER-ONLY. Absent when no assets
   *  resolved (e.g. a pinned version with no asset list). */
  downloads?: Partial<Record<DownloadSlot, ManifestDownload>>;
}

export interface UpdateManifest {
  /** On-disk schema version — lets consumers distinguish v1 from v2. */
  schema: typeof MANIFEST_SCHEMA_VERSION;
  /** ISO timestamp of when this document was generated. */
  generated: string;
  /** Channel-keyed map (stable / beta / nightly / …). Adding a stream is a
   *  server-side write, no schema change. */
  channels: Record<string, ManifestChannel>;
}

const REPO_URL = "https://github.com/stuffbucket/maximal";

/** A minimal asset shape — a subset of `site/src/lib/version.ts`'s ReleaseAsset
 *  — so this pure builder has no dependency on the build-time GitHub lookup. */
export interface ManifestAsset {
  name: string;
  url: string;
}

/** Input describing one channel's resolved release, as the build already knows
 *  it (from resolveLatestRelease / resolveLatestPrerelease). */
export interface ChannelReleaseInput {
  /** The release tag, e.g. "v0.4.39". */
  tag: string;
  /** The release's assets (empty for a pinned version). */
  assets: ManifestAsset[];
}

/** Match a release's assets to the well-known download slots. Mirrors the
 *  build-time selection in `site/src/lib/downloads.ts` so the site and the
 *  manifest advertise the same artifacts. An unmatched slot is omitted. */
export function resolveDownloads(
  assets: ManifestAsset[],
): Partial<Record<DownloadSlot, ManifestDownload>> {
  const downloads: Partial<Record<DownloadSlot, ManifestDownload>> = {};
  const add = (slot: DownloadSlot, asset: ManifestAsset | null | undefined) => {
    if (asset) downloads[slot] = { name: asset.name, url: asset.url };
  };

  add(
    "macos-arm64-dmg",
    assets.find((a) => /\.dmg$/i.test(a.name) && /arm64|aarch64/i.test(a.name)),
  );
  add(
    "macos-x64-dmg",
    assets.find((a) => /\.dmg$/i.test(a.name) && /x64|x86_64|intel/i.test(a.name)),
  );
  add(
    "windows-x64-setup",
    assets.find((a) => /-setup\.exe$/i.test(a.name)),
  );
  add(
    "windows-x64-msi",
    assets.find((a) => /\.msi$/i.test(a.name)),
  );
  add(
    "windows-x64-zip",
    assets.find((a) => /\.zip$/i.test(a.name) && /windows|win/i.test(a.name)),
  );
  add(
    "windows-install-ps1",
    assets.find((a) => /\.ps1$/i.test(a.name)),
  );

  return downloads;
}

/** Build one schema-2 channel entry from a resolved release. */
export function buildChannel(input: ChannelReleaseInput): ManifestChannel {
  const { tag, assets } = input;
  const channel: ManifestChannel = {
    version: tag.replace(/^v/, ""),
    tag,
    notes: `${REPO_URL}/releases/tag/${tag}`,
  };
  const downloads = resolveDownloads(assets);
  if (Object.keys(downloads).length > 0) channel.downloads = downloads;
  return channel;
}

/** Assemble the full schema-2 manifest from the channels that have a release.
 *  A channel key maps to null/undefined when that stream has no current release
 *  and is omitted (matching schema 1's "beta absent when no prerelease"). */
export function buildManifest(
  channels: Record<string, ChannelReleaseInput | null | undefined>,
  generated: string = new Date().toISOString(),
): UpdateManifest {
  const out: Record<string, ManifestChannel> = {};
  for (const [name, input] of Object.entries(channels)) {
    if (input) out[name] = buildChannel(input);
  }
  return {
    schema: MANIFEST_SCHEMA_VERSION,
    generated,
    channels: out,
  };
}

// ── Desktop updater manifest ────────────────────────────────────────────────
//
// The Windows and macOS apps install updates in place with
// tauri-plugin-updater, which reads its own document in Tauri's static JSON
// format at
//   https://mxml.sh/updates/desktop/<channel>.json
// (source file: site/public/updates/desktop/<channel>.json). Unlike
// `downloads` above, each `url` here IS what an app downloads and installs.
// That is safe because the app verifies the file's minisign signature against
// the public key built into it (`plugins.updater.pubkey` in
// shell/src-tauri/tauri.conf.json), and that the signature was made for
// `version`, before installing it. A tampered document can at most make the
// update fail; the app then sends the user to mxml.sh.

/** The updater targets the Windows NSIS app looks up, most specific first:
 *  `<os>-<arch>-<installer>`, then `<os>-<arch>` when the app can't tell how
 *  it was installed. NSIS is the only Windows app installer we ship, so both
 *  name the same file. */
export const DESKTOP_WINDOWS_TARGETS = [
  "windows-x86_64-nsis",
  "windows-x86_64",
] as const;

/** The updater targets the Apple Silicon macOS app looks up, most specific
 *  first, the same way: `app` is the plugin's name for a `.app` bundle. */
export const DESKTOP_MACOS_TARGETS = [
  "darwin-aarch64-app",
  "darwin-aarch64",
] as const;

export interface DesktopUpdatePlatform {
  /** The signed update's download URL (a GitHub release asset). */
  url: string;
  /** The update's `.sig` file content, exactly as the signer wrote it. */
  signature: string;
}

/** Tauri's static updater JSON. */
export interface DesktopUpdateManifest {
  /** Release version, no leading "v". Must equal the version the updates
   *  were signed for, or the apps refuse them. */
  version: string;
  /** Display-only link to the GitHub release. */
  notes: string;
  /** RFC 3339 publish time, when known. */
  pub_date?: string;
  platforms: Record<string, DesktopUpdatePlatform>;
}

/** A signed update the desktop apps can install: the release asset, the
 *  name of the asset holding its signature, and the targets that pick it. */
export interface DesktopUpdaterArtifact {
  targets: readonly string[];
  file: ManifestDownload;
  signatureName: string;
}

/** The release's signed desktop updates: the Windows NSIS installer
 *  (`*-setup.exe`) and the macOS app bundle (`*-darwin-arm64.app.tar.gz`,
 *  from stuffbucket/macos-builder). A file without its `<file>.sig` asset is
 *  left out. */
export function desktopUpdaterArtifacts(
  assets: ManifestAsset[],
): DesktopUpdaterArtifact[] {
  const candidates = [
    {
      targets: DESKTOP_WINDOWS_TARGETS,
      file: resolveDownloads(assets)["windows-x64-setup"],
    },
    {
      targets: DESKTOP_MACOS_TARGETS,
      file: assets.find(
        (a) => /\.app\.tar\.gz$/i.test(a.name) && /arm64|aarch64/i.test(a.name),
      ),
    },
  ];
  const artifacts: DesktopUpdaterArtifact[] = [];
  for (const { targets, file } of candidates) {
    if (!file) continue;
    const signatureName = `${file.name}.sig`;
    if (!assets.some((a) => a.name === signatureName)) continue;
    artifacts.push({
      targets,
      file: { name: file.name, url: file.url },
      signatureName,
    });
  }
  return artifacts;
}

export interface DesktopReleaseInput extends ChannelReleaseInput {
  /** The `.sig` assets' contents, keyed by asset name. */
  signatures: ReadonlyMap<string, string>;
  /** When the release was published (RFC 3339), if known. */
  publishedAt?: string | null;
}

/** Build one channel's desktop updater manifest, or null when the release has
 *  no signed desktop update to offer. */
export function buildDesktopManifest(
  input: DesktopReleaseInput,
): DesktopUpdateManifest | null {
  const platforms: Record<string, DesktopUpdatePlatform> = {};
  for (const artifact of desktopUpdaterArtifacts(input.assets)) {
    const signature = input.signatures.get(artifact.signatureName)?.trim();
    if (!signature) continue;
    for (const target of artifact.targets) {
      platforms[target] = { url: artifact.file.url, signature };
    }
  }
  if (Object.keys(platforms).length === 0) return null;
  const { version, notes } = buildChannel(input);
  return {
    version,
    notes,
    ...(input.publishedAt ? { pub_date: input.publishedAt } : {}),
    platforms,
  };
}
