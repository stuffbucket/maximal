// Runtime (browser) hydration of the download buttons + version pill from the
// canonical update manifest (issue #221, phase 2 of #218).
//
// The marketing site server-renders a RELEASE-INDEPENDENT fallback (a /releases
// href + generic label) so it works with JS off, for crawlers, and when the
// manifest fetch fails (fail-closed — see docs/decisions/site-runtime-version-manifest.md).
// At runtime a small bundled script fetches /updates/manifest.json and, IF it
// parses cleanly, upgrades the anchors + version pills in place. A failed or
// malformed fetch leaves the baked fallback untouched.
//
// This module is the PURE, unit-testable core: it takes an already-fetched,
// untyped JSON value and returns the browser-facing download data for the
// `stable` channel, or null when the document can't be trusted. It consumes the
// shared schema-2 types (updates-manifest.ts) rather than hardcoding the shape,
// so schema drift is a compile error here.
//
// SECURITY: reading `downloads.<slot>.url` here is intentional and in-scope —
// the site is browser-only and the URL is a user-visible, clickable link, so it
// adds no new trust surface. This is exactly the consumer the schema's SECURITY
// note permits (unlike the desktop client, which must read only `version`).

import type {
  DownloadSlot,
  ManifestDownload,
  UpdateManifest,
} from "./updates-manifest";
import { MANIFEST_SCHEMA_VERSION } from "./updates-manifest";

/** The channel the marketing site advertises. */
export const SITE_CHANNEL = "stable" as const;

/** The browser-facing download data hydration writes into the DOM. Every field
 *  is release-derived; an absent optional field means "keep the baked
 *  fallback" (macOS) or "coming soon" (Windows). */
export interface HydratedDownloads {
  /** Display version, e.g. "v0.4.39" (leading "v" restored for the pill). */
  versionLabel: string;
  /** Direct macOS .dmg URL, or null when no macOS slot resolved. */
  macDmg: string | null;
  /** Direct Windows installer URL, or null when Windows isn't offered yet. */
  winSetup: string | null;
  /** True iff a Windows installer slot is present. */
  hasWindows: boolean;
}

function isDownload(value: unknown): value is ManifestDownload {
  if (typeof value !== "object" || value === null) return false;
  const d = value as Record<string, unknown>;
  return typeof d.url === "string" && d.url.length > 0 && typeof d.name === "string";
}

/** Narrow an untyped, freshly-fetched JSON value to a schema-2 manifest we can
 *  trust enough to read. Returns null (⇒ keep the baked fallback) on anything
 *  unexpected: wrong schema, missing channel map. */
export function parseManifest(value: unknown): UpdateManifest | null {
  if (typeof value !== "object" || value === null) return null;
  const doc = value as Record<string, unknown>;
  if (doc.schema !== MANIFEST_SCHEMA_VERSION) return null;
  const channels = doc.channels;
  if (typeof channels !== "object" || channels === null) return null;
  return value as UpdateManifest;
}

/** Pick the first present download URL among the given role slots, in order. */
function firstSlotUrl(
  downloads: Partial<Record<DownloadSlot, ManifestDownload>> | undefined,
  slots: DownloadSlot[],
): string | null {
  if (!downloads) return null;
  for (const slot of slots) {
    const entry = downloads[slot];
    if (isDownload(entry)) return entry.url;
  }
  return null;
}

/** Read the browser-facing download data for the site channel from an already-
 *  fetched manifest value. Returns null when the document can't be trusted or
 *  the channel is absent — callers keep the server-rendered fallback. */
export function readStableDownloads(value: unknown): HydratedDownloads | null {
  const manifest = parseManifest(value);
  if (!manifest) return null;
  const channel = manifest.channels[SITE_CHANNEL];
  if (!channel || typeof channel.version !== "string" || !channel.version) {
    return null;
  }

  // Prefer the release's own tag for the pill; fall back to a "v"-prefixed
  // version when tag is missing/blank.
  const versionLabel =
    typeof channel.tag === "string" && channel.tag ? channel.tag : `v${channel.version}`;

  const macDmg = firstSlotUrl(channel.downloads, ["macos-arm64-dmg", "macos-x64-dmg"]);
  const winSetup = firstSlotUrl(channel.downloads, [
    "windows-x64-setup",
    "windows-x64-msi",
  ]);

  return {
    versionLabel,
    macDmg,
    winSetup,
    hasWindows: winSetup !== null,
  };
}
