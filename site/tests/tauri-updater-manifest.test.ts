/**
 * Unit tests for the Tauri v2 update manifest builder + resolver
 * (site/src/lib/tauri-updater-manifest.ts), which produces the `latest.json`
 * the desktop in-place self-updater polls.
 *
 * These guard the contract that makes the self-updater safe:
 *   1. The `darwin-arm64` asset FILENAME maps to the `darwin-aarch64` Tauri KEY.
 *   2. `version` is the tag with its leading "v" stripped.
 *   3. `signature` is the FULL TEXT of the `.sig` body, inlined (mocked fetch),
 *      and `url` points at the `.app.tar.gz` bundle (never the `.sig`/`.sha256`).
 *   4. FAIL CLOSED: with no updater artifact (or an empty signature body) the
 *      builder/resolver returns null — the route then writes NO latest.json — so
 *      a client never receives an unverifiable manifest.
 *
 * Colocated under site/tests (site's builder has no test runner of its own);
 * imports the pure module by relative path. No network — the signature fetch is
 * injected as a mock. Run with: `bun test site/tests/tauri-updater-manifest.test.ts`.
 */

import { describe, expect, test } from "bun:test";

import {
  buildUpdaterManifest,
  resolveUpdaterArtifact,
  resolveUpdaterAssets,
  serializeUpdaterManifest,
  TAURI_PLATFORM_DARWIN_AARCH64,
  type SignatureFetcher,
  type UpdaterAsset,
} from "../src/lib/tauri-updater-manifest";

const TAG = "v0.4.42";
const BASE = "https://github.com/stuffbucket/maximal/releases/download/v0.4.42";
const PUB_DATE = "2026-07-15T00:00:00.000Z";
const SIG_BODY =
  "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpCg==base64blob==";

const bundle: UpdaterAsset = {
  name: "maximal-v0.4.42-darwin-arm64.app.tar.gz",
  url: `${BASE}/maximal-v0.4.42-darwin-arm64.app.tar.gz`,
};
const sig: UpdaterAsset = {
  name: "maximal-v0.4.42-darwin-arm64.app.tar.gz.sig",
  url: `${BASE}/maximal-v0.4.42-darwin-arm64.app.tar.gz.sig`,
};
const sha256: UpdaterAsset = {
  name: "maximal-v0.4.42-darwin-arm64.app.tar.gz.sha256",
  url: `${BASE}/maximal-v0.4.42-darwin-arm64.app.tar.gz.sha256`,
};
const dmg: UpdaterAsset = {
  name: "maximal-v0.4.42-darwin-arm64.dmg",
  url: `${BASE}/maximal-v0.4.42-darwin-arm64.dmg`,
};

/** A signature fetcher that returns a fixed body for the `.sig` asset, and
 *  records which URL was fetched — proving the body is inlined from the `.sig`
 *  asset, not the bundle. */
function mockSignatureFetcher(body: string | null): {
  fetch: SignatureFetcher;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    fetch: async (asset: UpdaterAsset) => {
      calls.push(asset.url);
      return body;
    },
  };
}

describe("resolveUpdaterAssets", () => {
  test("maps the darwin-arm64 filename to the darwin-aarch64 Tauri key", () => {
    const resolved = resolveUpdaterAssets([dmg, sha256, bundle, sig]);
    expect(resolved).not.toBeNull();
    expect(resolved?.platform).toBe(TAURI_PLATFORM_DARWIN_AARCH64);
    expect(resolved?.platform).toBe("darwin-aarch64");
  });

  test("selects the .app.tar.gz bundle, not the .sig or .sha256 sibling", () => {
    const resolved = resolveUpdaterAssets([sha256, sig, bundle]);
    expect(resolved?.bundle.name).toBe(bundle.name);
    expect(resolved?.bundle.url).toBe(bundle.url);
    expect(resolved?.signatureAsset.name).toBe(sig.name);
  });

  test("returns null when the updater bundle is absent (only browser assets)", () => {
    expect(resolveUpdaterAssets([dmg])).toBeNull();
  });

  test("returns null when the bundle is present but its .sig is missing", () => {
    expect(resolveUpdaterAssets([dmg, sha256, bundle])).toBeNull();
  });

  test("returns null when a .sig is present but its bundle is absent", () => {
    // A partial/broken upload — the `.sig` (and `.sha256`) landed but the
    // `.app.tar.gz` it signs did not. The bundle guard must hold on its own,
    // not lean on the later signature guard to catch this.
    expect(resolveUpdaterAssets([dmg, sha256, sig])).toBeNull();
  });
});

describe("resolveUpdaterArtifact (signature inlined via mocked fetch)", () => {
  test("inlines the .sig body and fetches from the .sig asset's URL", async () => {
    const mock = mockSignatureFetcher(SIG_BODY);
    const artifact = await resolveUpdaterArtifact([dmg, bundle, sig], mock.fetch);
    expect(artifact).not.toBeNull();
    expect(artifact?.signature).toBe(SIG_BODY);
    // The signature must come from the .sig asset, never the bundle.
    expect(mock.calls).toEqual([sig.url]);
  });

  test("trims the fetched signature body", async () => {
    const mock = mockSignatureFetcher(`\n  ${SIG_BODY}  \n`);
    const artifact = await resolveUpdaterArtifact([bundle, sig], mock.fetch);
    expect(artifact?.signature).toBe(SIG_BODY);
  });

  test("fails closed (null) when the .sig body is empty/whitespace", async () => {
    for (const body of ["", "   \n\t "]) {
      const mock = mockSignatureFetcher(body);
      const artifact = await resolveUpdaterArtifact([bundle, sig], mock.fetch);
      expect(artifact).toBeNull();
    }
  });

  test("fails closed (null) when the .sig fetch returns null (e.g. 404)", async () => {
    const mock = mockSignatureFetcher(null);
    const artifact = await resolveUpdaterArtifact([bundle, sig], mock.fetch);
    expect(artifact).toBeNull();
  });

  test("does not fetch a signature when there is no updater bundle", async () => {
    const mock = mockSignatureFetcher(SIG_BODY);
    const artifact = await resolveUpdaterArtifact([dmg], mock.fetch);
    expect(artifact).toBeNull();
    // No signature fetch attempted — nothing to sign.
    expect(mock.calls).toEqual([]);
  });
});

describe("buildUpdaterManifest", () => {
  test("produces the exact Tauri dynamic-update shape", async () => {
    const mock = mockSignatureFetcher(SIG_BODY);
    const artifact = await resolveUpdaterArtifact([dmg, bundle, sig], mock.fetch);
    const manifest = buildUpdaterManifest({ tag: TAG, artifact, pubDate: PUB_DATE });

    expect(manifest).toEqual({
      version: "0.4.42",
      notes: "https://github.com/stuffbucket/maximal/releases/tag/v0.4.42",
      pub_date: PUB_DATE,
      platforms: {
        "darwin-aarch64": {
          signature: SIG_BODY,
          url: bundle.url,
        },
      },
    });
  });

  test("strips the leading v from the tag for `version`", async () => {
    const mock = mockSignatureFetcher(SIG_BODY);
    const artifact = await resolveUpdaterArtifact([bundle, sig], mock.fetch);
    expect(buildUpdaterManifest({ tag: "v1.2.3", artifact })?.version).toBe("1.2.3");
  });

  test("`url` points at the .app.tar.gz bundle, `signature` is the .sig body", async () => {
    const mock = mockSignatureFetcher(SIG_BODY);
    const artifact = await resolveUpdaterArtifact([bundle, sig], mock.fetch);
    const platform = buildUpdaterManifest({ tag: TAG, artifact })?.platforms[
      "darwin-aarch64"
    ];
    expect(platform?.url).toBe(bundle.url);
    expect(platform?.url).toMatch(/\.app\.tar\.gz$/);
    expect(platform?.signature).toBe(SIG_BODY);
  });

  test("FAILS CLOSED — returns null when there is no updater artifact", () => {
    // The current-release reality: no `.app.tar.gz`/`.sig` shipped yet.
    expect(buildUpdaterManifest({ tag: TAG, artifact: null })).toBeNull();
  });

  test("FAILS CLOSED — returns null when the artifact's signature is empty", () => {
    const emptySigArtifact = {
      platform: TAURI_PLATFORM_DARWIN_AARCH64,
      bundle,
      signatureAsset: sig,
      signature: "   ",
    };
    expect(buildUpdaterManifest({ tag: TAG, artifact: emptySigArtifact })).toBeNull();
  });

  test("end-to-end fail-closed: no bundle ⇒ no artifact ⇒ null manifest", async () => {
    const mock = mockSignatureFetcher(SIG_BODY);
    const artifact = await resolveUpdaterArtifact([dmg, sha256], mock.fetch);
    expect(artifact).toBeNull();
    expect(buildUpdaterManifest({ tag: TAG, artifact })).toBeNull();
  });
});

describe("serializeUpdaterManifest", () => {
  test("2-space indent + trailing newline (matches manifest.json)", async () => {
    const mock = mockSignatureFetcher(SIG_BODY);
    const artifact = await resolveUpdaterArtifact([bundle, sig], mock.fetch);
    const manifest = buildUpdaterManifest({ tag: TAG, artifact, pubDate: PUB_DATE });
    const text = serializeUpdaterManifest(manifest!);
    expect(text.endsWith("\n")).toBe(true);
    expect(text).toBe(`${JSON.stringify(manifest, null, 2)}\n`);
    // Round-trips to the same object.
    expect(JSON.parse(text)).toEqual(manifest);
  });
});
