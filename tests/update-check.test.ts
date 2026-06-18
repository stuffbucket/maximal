/**
 * Update-availability check (src/lib/update-check.ts). Drives the DI shim so the
 * GitHub fetch + clock are deterministic; BUILD_VERSION is the real running
 * version (package.json fallback in tests).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { BUILD_VERSION } from "~/lib/build-info"
import {
  __resetUpdateCheckDepsForTests,
  __setUpdateCheckDepsForTests,
  DOWNLOAD_URL,
  getUpdateStatus,
  isNewerVersion,
} from "~/lib/update-check"

const releaseJson = (tag: string): Response =>
  new Response(JSON.stringify({ tag_name: tag }), { status: 200 })

describe("isNewerVersion", () => {
  test("compares major/minor/patch numerically", () => {
    expect(isNewerVersion("0.4.27", "0.4.26")).toBe(true)
    expect(isNewerVersion("0.5.0", "0.4.99")).toBe(true)
    expect(isNewerVersion("1.0.0", "0.9.9")).toBe(true)
    expect(isNewerVersion("0.4.26", "0.4.26")).toBe(false)
    expect(isNewerVersion("0.4.25", "0.4.26")).toBe(false)
  })

  test("strips leading v and prerelease suffix", () => {
    expect(isNewerVersion("v0.4.27", "0.4.26")).toBe(true)
    // prerelease suffix stripped → 0.4.27 == 0.4.27 → not strictly newer
    expect(isNewerVersion("0.4.27-rc.1", "0.4.27")).toBe(false)
  })

  test("missing patch segment reads as 0", () => {
    expect(isNewerVersion("0.4", "0.3.9")).toBe(true)
    expect(isNewerVersion("0.4", "0.4.1")).toBe(false)
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
        return Promise.resolve(releaseJson("v999.0.0"))
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
      fetch: () => Promise.resolve(releaseJson("v0.0.1")),
    })

    const status = await getUpdateStatus()

    expect(status.latest).toBe("0.0.1")
    expect(status.update_available).toBe(false)
  })

  test("caches within the TTL; force bypasses it", async () => {
    let clock = 1_000_000
    __setUpdateCheckDepsForTests({
      fetch: () => {
        fetchCalls++
        return Promise.resolve(releaseJson("v999.0.0"))
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
})
