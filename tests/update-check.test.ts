/**
 * Update-availability check (src/lib/update-check.ts). Drives the DI shim so the
 * releases-CDN fetch + clock are deterministic; BUILD_VERSION is the real
 * running version (package.json fallback in tests).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { BUILD_VERSION } from "~/lib/build-info"
import {
  __resetUpdateCheckDepsForTests,
  __setUpdateCheckDepsForTests,
  DOWNLOAD_URL,
  getUpdateStatus,
  isNewerVersion,
  parseManifestVersion,
} from "~/lib/update-check"

/** A manifest body advertising `version` on the `stable` channel, exactly as
 *  the site build emits it. */
const manifestBody = (version: unknown): string =>
  JSON.stringify({ schema: 1, channels: { stable: { version } } })

const manifestJson = (version: string): Response =>
  new Response(manifestBody(version), { status: 200 })

describe("isNewerVersion", () => {
  test("compares major/minor/patch numerically", () => {
    expect(isNewerVersion("0.4.27", "0.4.26")).toBe(true)
    expect(isNewerVersion("0.5.0", "0.4.99")).toBe(true)
    expect(isNewerVersion("1.0.0", "0.9.9")).toBe(true)
    expect(isNewerVersion("0.4.26", "0.4.26")).toBe(false)
    expect(isNewerVersion("0.4.25", "0.4.26")).toBe(false)
  })

  test("strips leading v and treats prerelease as older than release", () => {
    expect(isNewerVersion("v0.4.27", "0.4.26")).toBe(true)
    expect(isNewerVersion("0.4.27-rc.1", "0.4.27")).toBe(false)
  })

  test("compares prerelease precedence on equal core versions", () => {
    expect(isNewerVersion("0.5.0-beta.1", "0.5.0-beta.0")).toBe(true)
    expect(isNewerVersion("0.5.0", "0.5.0-beta.3")).toBe(true)
    expect(isNewerVersion("0.5.0-beta.3", "0.5.0")).toBe(false)
    expect(isNewerVersion("0.5.0-beta.10", "0.5.0-beta.2")).toBe(true)
    expect(isNewerVersion("0.5.0-rc.0", "0.5.0-beta.9")).toBe(true)
  })

  test("lets differing core versions decide before prerelease", () => {
    expect(isNewerVersion("0.5.0-beta.1", "0.4.9")).toBe(true)
  })

  test("missing patch segment reads as 0", () => {
    expect(isNewerVersion("0.4", "0.3.9")).toBe(true)
    expect(isNewerVersion("0.4", "0.4.1")).toBe(false)
  })
})

describe("parseManifestVersion", () => {
  test("reads the channel's version, tolerating a leading v", () => {
    expect(parseManifestVersion(manifestBody("0.4.32"))).toBe("0.4.32")
    expect(parseManifestVersion(manifestBody("v0.4.32"))).toBe("0.4.32")
    expect(parseManifestVersion(manifestBody("0.5.0-rc.1"))).toBe("0.5.0-rc.1")
  })

  test("selects the requested channel", () => {
    const multi = JSON.stringify({
      channels: {
        stable: { version: "0.4.32" },
        beta: { version: "0.5.0-rc.1" },
      },
    })
    expect(parseManifestVersion(multi, "beta")).toBe("0.5.0-rc.1")
    expect(parseManifestVersion(multi, "stable")).toBe("0.4.32")
  })

  test("returns null for unrecognized shapes", () => {
    expect(parseManifestVersion("<!DOCTYPE html>")).toBeNull() // not JSON
    expect(parseManifestVersion("{}")).toBeNull() // no channels
    expect(parseManifestVersion(JSON.stringify({ channels: {} }))).toBeNull()
    expect(parseManifestVersion(manifestBody(42))).toBeNull() // non-string version
    expect(parseManifestVersion(manifestBody("0.4"))).toBeNull() // incomplete x.y.z
  })

  test("an absent requested channel degrades to null", () => {
    expect(parseManifestVersion(manifestBody("0.4.32"), "beta")).toBeNull()
  })
})

describe("getUpdateStatus", () => {
  let fetchCalls = 0

  beforeEach(() => {
    fetchCalls = 0
    __resetUpdateCheckDepsForTests()
  })
  afterEach(() => {
    __resetUpdateCheckDepsForTests()
  })

  test("reports update_available when the latest tag is newer", async () => {
    __setUpdateCheckDepsForTests({
      fetch: () => {
        fetchCalls++
        return Promise.resolve(manifestJson("v999.0.0"))
      },
    })

    const status = await getUpdateStatus()

    expect(status.current).toBe(BUILD_VERSION)
    expect(status.latest).toBe("999.0.0")
    expect(status.update_available).toBe(true)
    // Install-channel-neutral download page, never a raw asset.
    expect(status.url).toBe(DOWNLOAD_URL)
    expect(DOWNLOAD_URL).toBe("https://mxml.sh/maximal/")
  })

  test("reports up to date when the latest tag is not newer", async () => {
    __setUpdateCheckDepsForTests({
      fetch: () => Promise.resolve(manifestJson("v0.0.1")),
    })

    const status = await getUpdateStatus()

    expect(status.latest).toBe("0.0.1")
    expect(status.update_available).toBe(false)
  })

  test("a dev build of the current release is up to date, not an upgrade", async () => {
    // build-sidecar.ts stamps local binaries `<version>-dev+<sha>`; the
    // published release of that same version must not read as an upgrade
    // (a prerelease ranks below its release, so the naive compare flips it).
    __setUpdateCheckDepsForTests({
      fetch: () => Promise.resolve(manifestJson("0.4.35")),
      currentVersion: "0.4.35-dev+abc12345",
    })

    const status = await getUpdateStatus()

    expect(status.current).toBe("0.4.35-dev+abc12345") // full string, for diagnostics
    expect(status.latest).toBe("0.4.35")
    expect(status.update_available).toBe(false)
  })

  test("a dev build still sees a genuinely newer release", async () => {
    __setUpdateCheckDepsForTests({
      fetch: () => Promise.resolve(manifestJson("0.4.36")),
      currentVersion: "0.4.35-dev+abc12345",
    })

    const status = await getUpdateStatus()

    expect(status.update_available).toBe(true)
  })

  test("a real prerelease still sees its release as an upgrade", async () => {
    // Only the `-dev+` local suffix is normalized; a beta/rc genuinely precedes
    // the release and should still be offered the upgrade.
    __setUpdateCheckDepsForTests({
      fetch: () => Promise.resolve(manifestJson("0.5.0")),
      currentVersion: "0.5.0-beta.2",
    })

    const status = await getUpdateStatus()

    expect(status.update_available).toBe(true)
  })

  test("caches within the TTL; force bypasses it", async () => {
    let clock = 1_000_000
    __setUpdateCheckDepsForTests({
      fetch: () => {
        fetchCalls++
        return Promise.resolve(manifestJson("v999.0.0"))
      },
      now: () => clock,
    })

    await getUpdateStatus()
    await getUpdateStatus()
    expect(fetchCalls).toBe(1) // second call served from cache

    clock += 1000 // still within TTL
    await getUpdateStatus()
    expect(fetchCalls).toBe(1)

    await getUpdateStatus(true) // force bypasses cache
    expect(fetchCalls).toBe(2)
  })

  test("degrades to a coherent 'unknown' on fetch failure", async () => {
    __setUpdateCheckDepsForTests({
      fetch: () => Promise.reject(new Error("offline")),
    })

    const status = await getUpdateStatus()

    expect(status.current).toBe(BUILD_VERSION)
    expect(status.latest).toBeNull()
    expect(status.update_available).toBe(false)
    expect(status.url).toBe(DOWNLOAD_URL)
  })

  test("degrades to 'unknown' on a non-200 (e.g. rate limited)", async () => {
    __setUpdateCheckDepsForTests({
      fetch: () => Promise.resolve(new Response("limit", { status: 403 })),
    })

    const status = await getUpdateStatus()

    expect(status.latest).toBeNull()
    expect(status.update_available).toBe(false)
  })

  test("requests the canonical manifest URL, not the REST API", async () => {
    let requested = ""
    __setUpdateCheckDepsForTests({
      fetch: (url: string) => {
        requested = url
        return Promise.resolve(manifestJson("v999.0.0"))
      },
    })

    await getUpdateStatus()

    // The Pages/Fastly origin directly — not the mxml.sh Caddy proxy (fewest
    // hops + smallest trust surface for a machine poll).
    expect(requested).toBe(
      "https://stuffbucket.github.io/maximal/updates/manifest.json",
    )
    expect(requested).not.toContain("mxml.sh")
    // Never the rate-limited REST API.
    expect(requested).not.toContain("api.github.com")
  })

  test("degrades to 'unknown' on a 200 with an unparseable body", async () => {
    __setUpdateCheckDepsForTests({
      fetch: () =>
        Promise.resolve(new Response("<html>nope</html>", { status: 200 })),
    })

    const status = await getUpdateStatus()

    expect(status.latest).toBeNull()
    expect(status.update_available).toBe(false)
  })
})
