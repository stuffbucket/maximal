/**
 * Update-availability check (src/lib/update-check.ts). Drives the DI shim so the
 * releases-CDN fetch + clock are deterministic; BUILD_VERSION is the real
 * running version (package.json fallback in tests).
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"

import { BUILD_VERSION } from "~/lib/update/build-info"
import {
  __resetUpdateCheckDepsForTests,
  __setUpdateCheckDepsForTests,
  DOWNLOAD_URL,
  FORCE_MIN_INTERVAL_MS,
  getUpdateStatus,
  isNewerVersion,
  MANIFEST_URL_OVERRIDE_ENV,
  parseManifestVersion,
  peekUpdateStatus,
  resolveManifestUrl,
  type UpdateStatus,
} from "~/lib/update/update-check"

// The test preload points every check at a closed loopback port so spawned
// servers stay offline; these tests assert the real URL, so lift that here.
const preloadOverride = process.env[MANIFEST_URL_OVERRIDE_ENV]
beforeAll(() => {
  delete process.env.MAXIMAL_TEST_UPDATE_MANIFEST_URL
})
afterAll(() => {
  if (preloadOverride !== undefined) {
    process.env[MANIFEST_URL_OVERRIDE_ENV] = preloadOverride
  }
})

/** A manifest body advertising `version` on the `stable` channel, exactly as
 *  the site build emits it. */
const manifestBody = (version: unknown): string =>
  JSON.stringify({ schema: 1, channels: { stable: { version } } })

const manifestJson = (version: string): Response =>
  new Response(manifestBody(version), { status: 200 })

/** A 200 manifest carrying cache validators (`etag`, `last-modified`). */
const withValidators = (
  version: string,
  headers: Record<string, string>,
): Response => new Response(manifestBody(version), { status: 200, headers })

const notModified = (): Response => new Response(null, { status: 304 })

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
    expect(DOWNLOAD_URL).toBe("https://mxml.sh/")
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

    clock += FORCE_MIN_INTERVAL_MS // still within the TTL
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

    // mxml.sh directly — now a Fastly-backed GitHub Pages custom domain (not the
    // old Caddy proxy), so it's the CDN origin: fewest hops + smallest trust
    // surface for a machine poll.
    expect(requested).toBe("https://mxml.sh/updates/manifest.json")
    // Never the retired /maximal Caddy path…
    expect(requested).not.toContain("/maximal/")
    // …and never the rate-limited REST API.
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

describe("getUpdateStatus — conditional CDN revalidation", () => {
  interface Seen {
    url: string
    headers: Headers
  }
  let seen: Array<Seen>
  let clock: number

  /** Fetch stub that records every request and answers from `responses` in
   *  order (the last one repeats). */
  const scripted =
    (responses: Array<() => Response>) =>
    (url: string, init?: RequestInit): Promise<Response> => {
      seen.push({ url, headers: new Headers(init?.headers) })
      const next = responses[Math.min(seen.length - 1, responses.length - 1)]
      return Promise.resolve(next())
    }

  /** A forced check after the forced-check window has passed, so it makes a
   *  real (conditional) fetch. */
  const recheck = (): Promise<UpdateStatus> => {
    clock += FORCE_MIN_INTERVAL_MS
    return getUpdateStatus(true)
  }

  beforeEach(() => {
    seen = []
    clock = 1_000_000
    __resetUpdateCheckDepsForTests()
  })
  afterEach(() => {
    __resetUpdateCheckDepsForTests()
  })

  test("asks intermediaries to revalidate, with no validators on a cold cache", async () => {
    __setUpdateCheckDepsForTests({
      fetch: scripted([() => manifestJson("999.0.0")]),
      now: () => clock,
    })

    await getUpdateStatus()

    expect(seen).toHaveLength(1)
    expect(seen[0].headers.get("cache-control")).toBe("no-cache")
    expect(seen[0].headers.get("if-none-match")).toBeNull()
    expect(seen[0].headers.get("if-modified-since")).toBeNull()
    // No cache-busting query string: Fastly ignores it, so it would only
    // fragment the CDN cache.
    expect(seen[0].url).toBe("https://mxml.sh/updates/manifest.json")
  })

  test("revalidates with the ETag exactly as received (weak) and Last-Modified", async () => {
    const lastModified = "Mon, 26 Oct 2026 12:00:00 GMT"
    __setUpdateCheckDepsForTests({
      fetch: scripted([
        () =>
          withValidators("999.0.0", {
            etag: 'W/"abc123"',
            "last-modified": lastModified,
          }),
        notModified,
      ]),
      now: () => clock,
    })

    await getUpdateStatus()
    await recheck()

    expect(seen).toHaveLength(2)
    expect(seen[1].headers.get("if-none-match")).toBe('W/"abc123"')
    expect(seen[1].headers.get("if-modified-since")).toBe(lastModified)
    expect(seen[1].headers.get("cache-control")).toBe("no-cache")
  })

  test("sends only the validators the server provided", async () => {
    __setUpdateCheckDepsForTests({
      fetch: scripted([
        () => withValidators("999.0.0", { etag: '"strong-1"' }),
        notModified,
      ]),
      now: () => clock,
    })

    await getUpdateStatus()
    await recheck()

    expect(seen[1].headers.get("if-none-match")).toBe('"strong-1"')
    expect(seen[1].headers.get("if-modified-since")).toBeNull()
  })

  test("a 304 reuses the cached manifest and refreshes checked_at", async () => {
    __setUpdateCheckDepsForTests({
      fetch: scripted([
        () => withValidators("999.0.0", { etag: '"v1"' }),
        notModified,
      ]),
      now: () => clock,
    })

    const first = await getUpdateStatus()
    clock += 60_000
    const second = await recheck()

    expect(second.latest).toBe("999.0.0")
    expect(second.update_available).toBe(true)
    expect(second.last_error).toBeNull()
    expect(second.checked_at).toBe(new Date(clock).toISOString())
    expect(second.checked_at).not.toBe(first.checked_at)
  })

  test("a 304 result is cached like a 200", async () => {
    __setUpdateCheckDepsForTests({
      fetch: scripted([
        () => withValidators("999.0.0", { etag: '"v1"' }),
        notModified,
      ]),
      now: () => clock,
    })

    await getUpdateStatus()
    await recheck()
    await getUpdateStatus()

    expect(seen).toHaveLength(2)
  })

  test("a changed manifest replaces the cached body and validators", async () => {
    __setUpdateCheckDepsForTests({
      fetch: scripted([
        () => withValidators("1.0.0", { etag: '"v1"' }),
        () => withValidators("999.0.0", { etag: '"v2"' }),
        notModified,
      ]),
      now: () => clock,
    })

    await getUpdateStatus()
    const changed = await recheck()
    const revalidated = await recheck()

    expect(changed.latest).toBe("999.0.0")
    expect(seen[2].headers.get("if-none-match")).toBe('"v2"')
    expect(revalidated.latest).toBe("999.0.0")
  })

  test("a 200 without validators drops the old ones", async () => {
    __setUpdateCheckDepsForTests({
      fetch: scripted([
        () => withValidators("1.0.0", { etag: '"v1"' }),
        () => manifestJson("999.0.0"),
      ]),
      now: () => clock,
    })

    await getUpdateStatus()
    await recheck()
    await recheck()

    expect(seen[2].headers.get("if-none-match")).toBeNull()
    expect(seen[2].headers.get("if-modified-since")).toBeNull()
  })

  test("an unexpected 304 with no cached body is an error, not a result", async () => {
    __setUpdateCheckDepsForTests({
      fetch: scripted([notModified]),
      now: () => clock,
    })

    const status = await getUpdateStatus()

    expect(status.latest).toBeNull()
    expect(status.update_available).toBe(false)
    expect(status.last_error).toBe("manifest fetch returned HTTP 304")
  })

  test("an error after a success keeps the last known result and validators", async () => {
    __setUpdateCheckDepsForTests({
      fetch: scripted([
        () => withValidators("999.0.0", { etag: '"v1"' }),
        () => new Response("boom", { status: 503 }),
        notModified,
      ]),
      now: () => clock,
    })

    await getUpdateStatus()
    const failed = await recheck()
    const recovered = await recheck()

    expect(failed.latest).toBe("999.0.0")
    expect(failed.update_available).toBe(true)
    expect(failed.last_error).toBe("manifest fetch returned HTTP 503")
    expect(seen[2].headers.get("if-none-match")).toBe('"v1"')
    expect(recovered.latest).toBe("999.0.0")
    expect(recovered.last_error).toBeNull()
  })

  test("a network error keeps the last known result", async () => {
    let calls = 0
    __setUpdateCheckDepsForTests({
      fetch: () => {
        calls++
        return calls === 1 ?
            Promise.resolve(withValidators("999.0.0", { etag: '"v1"' }))
          : Promise.reject(new Error("offline"))
      },
      now: () => clock,
    })

    await getUpdateStatus()
    const failed = await recheck()

    expect(failed.latest).toBe("999.0.0")
    expect(failed.update_available).toBe(true)
    expect(failed.last_error).toBe("network error: offline")
  })
})

describe("getUpdateStatus — forced checks", () => {
  let calls: number
  let clock: number
  let version: string

  beforeEach(() => {
    calls = 0
    clock = 1_000_000
    version = "v999.0.0"
    __resetUpdateCheckDepsForTests()
    __setUpdateCheckDepsForTests({
      fetch: () => {
        calls++
        return Promise.resolve(manifestJson(version))
      },
      now: () => clock,
    })
  })
  afterEach(() => {
    __resetUpdateCheckDepsForTests()
  })

  test("a forced check on a cold cache fetches", async () => {
    const status = await getUpdateStatus(true)
    expect(calls).toBe(1)
    expect(status.latest).toBe("999.0.0")
  })

  test("a forced check right after a fetch returns that result without fetching", async () => {
    await getUpdateStatus()
    version = "v1000.0.0" // would show if it refetched
    const status = await getUpdateStatus(true)
    expect(calls).toBe(1)
    expect(status.latest).toBe("999.0.0")
  })

  test("forced checks are limited to one real fetch per window", async () => {
    await getUpdateStatus(true)
    for (let i = 0; i < 10; i++) {
      clock += 1000
      await getUpdateStatus(true)
    }
    expect(calls).toBe(1) // 10s in, ten more tries
    clock += FORCE_MIN_INTERVAL_MS
    await getUpdateStatus(true)
    expect(calls).toBe(2)
  })

  test("the window opens exactly at the limit", async () => {
    await getUpdateStatus(true)
    clock += FORCE_MIN_INTERVAL_MS - 1
    await getUpdateStatus(true)
    expect(calls).toBe(1)
    clock += 1
    await getUpdateStatus(true)
    expect(calls).toBe(2)
  })

  test("a forced check after the window picks up a new release", async () => {
    await getUpdateStatus(true)
    version = "v1000.0.0"
    clock += FORCE_MIN_INTERVAL_MS
    const status = await getUpdateStatus(true)
    expect(status.latest).toBe("1000.0.0")
  })

  test("concurrent forced checks share one fetch", async () => {
    const [a, b, c] = await Promise.all([
      getUpdateStatus(true),
      getUpdateStatus(true),
      getUpdateStatus(true),
    ])
    expect(calls).toBe(1)
    expect(b).toBe(a)
    expect(c).toBe(a)
  })

  test("a failed forced check counts against the limit and reports the error", async () => {
    __setUpdateCheckDepsForTests({
      fetch: () => {
        calls++
        return Promise.reject(new Error("offline"))
      },
    })
    const first = await getUpdateStatus(true)
    clock += 1000
    const second = await getUpdateStatus(true)
    expect(calls).toBe(1)
    expect(first.last_error).toContain("offline")
    expect(second.last_error).toContain("offline")
  })

  test("a clock that steps backwards does not freeze the limit", async () => {
    await getUpdateStatus(true)
    clock -= 60 * 60 * 1000
    await getUpdateStatus(true)
    expect(calls).toBe(2)
  })

  test("an unforced check is not limited by the window", async () => {
    // Cache expired and the fetch failed: the next unforced call retries.
    __setUpdateCheckDepsForTests({
      fetch: () => {
        calls++
        return Promise.reject(new Error("offline"))
      },
    })
    await getUpdateStatus()
    await getUpdateStatus()
    expect(calls).toBe(2)
  })
})

describe("getUpdateStatus — how an install updates", () => {
  beforeEach(() => {
    __resetUpdateCheckDepsForTests()
  })
  afterEach(() => {
    __resetUpdateCheckDepsForTests()
  })

  test("an apt install gets the apt command and the Linux guide", async () => {
    __setUpdateCheckDepsForTests({
      fetch: () => Promise.resolve(manifestJson("v999.0.0")),
      aptInstall: { desktop: false },
    })

    const status = await getUpdateStatus()

    expect(status.update_available).toBe(true)
    expect(status.update_command).toBe(
      "sudo apt update && sudo apt install --only-upgrade maximal",
    )
    expect(status.url).toBe(
      "https://github.com/stuffbucket/maximal/blob/main/docs/linux.md#update",
    )
  })

  test("an apt install with the desktop app upgrades both packages", async () => {
    __setUpdateCheckDepsForTests({
      fetch: () => Promise.resolve(manifestJson("v999.0.0")),
      aptInstall: { desktop: true },
    })

    const status = await getUpdateStatus()

    expect(status.update_command).toBe(
      "sudo apt update && sudo apt install --only-upgrade maximal maximal-desktop",
    )
  })

  test("every other install keeps the download page and no command", async () => {
    __setUpdateCheckDepsForTests({
      fetch: () => Promise.resolve(manifestJson("v999.0.0")),
      aptInstall: null,
    })

    const status = await getUpdateStatus()

    expect(status.update_command).toBeNull()
    expect(status.url).toBe(DOWNLOAD_URL)
  })

  test("peekUpdateStatus reports the last check without fetching", async () => {
    let calls = 0
    __setUpdateCheckDepsForTests({
      fetch: () => {
        calls++
        return Promise.resolve(manifestJson("v999.0.0"))
      },
      aptInstall: null,
    })

    expect(peekUpdateStatus()).toBeNull()
    await getUpdateStatus()
    expect(peekUpdateStatus()?.latest).toBe("999.0.0")
    expect(calls).toBe(1)
  })
})

describe("resolveManifestUrl", () => {
  const canonical = "https://mxml.sh/updates/manifest.json"

  test("is the canonical CDN URL by default", () => {
    expect(resolveManifestUrl({})).toBe(canonical)
  })

  test("honors a loopback override for tests", () => {
    expect(
      resolveManifestUrl({
        [MANIFEST_URL_OVERRIDE_ENV]: "http://127.0.0.1:8765/manifest.json",
      }),
    ).toBe("http://127.0.0.1:8765/manifest.json")
    expect(
      resolveManifestUrl({
        [MANIFEST_URL_OVERRIDE_ENV]: "http://localhost:8765/m.json",
      }),
    ).toBe("http://localhost:8765/m.json")
  })

  test("ignores an override that isn't loopback http(s)", () => {
    for (const value of [
      "https://example.com/manifest.json",
      "https://127.0.0.1.example.com/m.json",
      "file:///etc/passwd",
      "not a url",
    ]) {
      expect(resolveManifestUrl({ [MANIFEST_URL_OVERRIDE_ENV]: value })).toBe(
        canonical,
      )
    }
  })
})
