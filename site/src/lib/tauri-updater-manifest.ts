// Schema + pure builder for the Tauri v2 "dynamic" update manifest the project
// publishes alongside the notify-only schema-2 manifest, at the canonical,
// CDN-cached, no-auth URL:
//   https://mxml.sh/updates/latest.json
//
// The desktop app's tauri.conf.json points its updater plugin at this URL:
//   "plugins": { "updater": { "pubkey": "…", "endpoints": ["…/latest.json"] } }
// Tauri GETs it and expects EXACTLY the shape below (see UpdaterManifest). This
// is a SECOND, INDEPENDENT consumer from manifest.json:
//   - manifest.json (schema 2)  → notify-only; desktop reads `version`, the URL
//     it downloads from is a compile-time constant, so a tampered manifest can
//     at most misreport a version.
//   - latest.json (this file)   → drives the IN-PLACE self-updater. The client
//     DOWNLOADS `platforms.<key>.url` and verifies `platforms.<key>.signature`
//     against the pinned `pubkey`. A bad `signature` or a wrong `url` makes
//     EVERY client's update fail signature verification, so this builder FAILS
//     CLOSED: it returns null (⇒ no latest.json is written) unless it has a real
//     updater artifact AND its real detached signature. It NEVER emits a
//     placeholder url or an empty/missing signature.
//
// SECURITY INVARIANT — `signature` is the FULL TEXT of the `.app.tar.gz.sig`
// asset (a minisign/Tauri base64 blob), inlined at build time, NOT a URL. `url`
// is the `.app.tar.gz` asset's download URL. Both come from the release's own
// assets; there is no name-guessing fallback that could point at a stale build.

/** The Tauri `platforms` key for the one target the macos-builder ships today.
 *  NOTE the deliberate FILENAME↔KEY mismatch: the release asset is named
 *  `…-darwin-arm64.app.tar.gz`, but Tauri's platform key MUST be
 *  `darwin-aarch64`. `resolveUpdaterPlatform` maps the former to the latter. */
export const TAURI_PLATFORM_DARWIN_AARCH64 = "darwin-aarch64" as const;

export type TauriPlatform = typeof TAURI_PLATFORM_DARWIN_AARCH64;

/** One platform's update payload — the exact fields Tauri's updater reads. */
export interface UpdaterPlatform {
  /** FULL TEXT contents of the `.app.tar.gz.sig` asset (a base64 blob), inlined
   *  at build time. NOT a URL — Tauri verifies this against the pinned pubkey. */
  signature: string;
  /** Direct download URL of the `.app.tar.gz` updater bundle. */
  url: string;
}

/** The Tauri v2 dynamic update JSON document. */
export interface UpdaterManifest {
  /** Release version WITHOUT a leading "v" (e.g. "0.4.42"). */
  version: string;
  /** Release notes, or a link to them. */
  notes: string;
  /** RFC 3339 publish timestamp. */
  pub_date: string;
  /** Per-target update payloads, keyed by Tauri's `{os}-{arch}` platform id. */
  platforms: Partial<Record<TauriPlatform, UpdaterPlatform>>;
}

const REPO_URL = "https://github.com/stuffbucket/maximal";

/** A minimal asset shape — the same {name,url} subset the schema-2 builder
 *  (updates-manifest.ts) consumes — so this pure builder needs no dependency on
 *  the build-time GitHub lookup. */
export interface UpdaterAsset {
  name: string;
  url: string;
}

/** A resolved updater artifact: the `.app.tar.gz` bundle, its detached
 *  signature asset, and the FULL TEXT of that signature (fetched at build time).
 *  All three are required — a builder that can't produce all of them fails
 *  closed rather than emit an unverifiable manifest. */
export interface ResolvedUpdaterArtifact {
  platform: TauriPlatform;
  /** The `.app.tar.gz` asset the client downloads. */
  bundle: UpdaterAsset;
  /** The `.app.tar.gz.sig` asset whose body was fetched. */
  signatureAsset: UpdaterAsset;
  /** The full text body of `signatureAsset`. */
  signature: string;
}

/** All inputs the pure builder needs, already resolved by the build (route). */
export interface UpdaterManifestInput {
  /** The release tag, e.g. "v0.4.42". */
  tag: string;
  /** The resolved updater artifact, or null when the release ships none yet
   *  (true for every release until the macos-builder updater artifact lands).
   *  A null artifact ⇒ the builder fails closed (returns null). */
  artifact: ResolvedUpdaterArtifact | null;
  /** RFC 3339 publish timestamp. Defaults to now when omitted. */
  pubDate?: string;
}

/** Locate the `.app.tar.gz` updater bundle + its `.sig` in a release's assets,
 *  and map the `darwin-arm64` FILENAME to the `darwin-aarch64` Tauri KEY. Returns
 *  null when either the bundle or its detached signature asset is absent — the
 *  caller then fails closed. This never inspects the `.sha256` asset (it's a
 *  human-facing checksum, not part of the Tauri contract). */
export function resolveUpdaterAssets(
  assets: UpdaterAsset[],
): {
  platform: TauriPlatform;
  bundle: UpdaterAsset;
  signatureAsset: UpdaterAsset;
} | null {
  // The macos-builder ships `maximal-{tag}-darwin-arm64.app.tar.gz` (+ `.sig`,
  // `.sha256`). Match the bundle by its full suffix so a `.sig`/`.sha256` sibling
  // can never be mistaken for the bundle itself.
  const bundle = assets.find((a) =>
    /darwin-arm64\.app\.tar\.gz$/i.test(a.name),
  );
  if (!bundle) return null;
  const signatureAsset = assets.find((a) =>
    /darwin-arm64\.app\.tar\.gz\.sig$/i.test(a.name),
  );
  if (!signatureAsset) return null;
  return {
    platform: TAURI_PLATFORM_DARWIN_AARCH64,
    bundle,
    signatureAsset,
  };
}

/** Fetch the body of a signature asset. Returns the trimmed text, or null when
 *  the body is missing/empty (⇒ fail closed). Matches the fetch contract the
 *  route uses so the resolver can be exercised with a mocked fetch in tests. */
export type SignatureFetcher = (asset: UpdaterAsset) => Promise<string | null>;

/**
 * Resolve the full updater artifact — bundle + detached-signature asset + the
 * INLINED signature body (fetched via `fetchSignature`) — for a release's assets,
 * or null when the release ships no updater artifact yet OR its signature body is
 * missing/empty. This is the single, injectable, unit-testable place the
 * fail-closed decisions live; the route just supplies the real fetch.
 */
export async function resolveUpdaterArtifact(
  assets: UpdaterAsset[],
  fetchSignature: SignatureFetcher,
): Promise<ResolvedUpdaterArtifact | null> {
  const resolved = resolveUpdaterAssets(assets);
  if (!resolved) return null;
  const signature = await fetchSignature(resolved.signatureAsset);
  if (!signature) return null;
  const trimmed = signature.trim();
  if (!trimmed) return null;
  return { ...resolved, signature: trimmed };
}

/**
 * Build the Tauri `latest.json` document from a resolved release + updater
 * artifact. FAILS CLOSED — returns null (⇒ the caller writes NO latest.json)
 * when there is no artifact, or when the artifact's inlined signature is empty
 * — so a client's updater never receives an unverifiable manifest.
 */
export function buildUpdaterManifest(
  input: UpdaterManifestInput,
): UpdaterManifest | null {
  const { tag, artifact } = input;
  if (!artifact) return null;
  const signature = artifact.signature.trim();
  if (!signature) return null;

  return {
    version: tag.replace(/^v/, ""),
    notes: `${REPO_URL}/releases/tag/${tag}`,
    pub_date: input.pubDate ?? new Date().toISOString(),
    platforms: {
      [artifact.platform]: {
        signature,
        url: artifact.bundle.url,
      },
    },
  };
}

/** Serialize identically to the schema-2 manifest route (2-space indent +
 *  trailing newline) so both update documents ship the same on-disk shape. */
export function serializeUpdaterManifest(manifest: UpdaterManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}
