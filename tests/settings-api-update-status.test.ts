/**
 * GET /settings/api/update-status. `?force=1` is the "Check for updates"
 * action: it skips the 6-hour cache (but not the forced-check rate limit), and
 * the response keeps the same shape either way.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Hono } from "hono"

import { UpdateStatusResponse } from "~/lib/config/settings-types"
import {
  __resetUpdateCheckDepsForTests,
  __setUpdateCheckDepsForTests,
  FORCE_MIN_INTERVAL_MS,
} from "~/lib/update/update-check"
import { settingsApiRoutes } from "~/routes/settings/api"

const app = new Hono()
app.route("/settings/api", settingsApiRoutes)

const manifest = (version: string): Response =>
  new Response(
    JSON.stringify({ schema: 1, channels: { stable: { version } } }),
    { status: 200 },
  )

const get = async (query = ""): Promise<UpdateStatusResponse> => {
  const res = await app.request(`/settings/api/update-status${query}`)
  expect(res.status).toBe(200)
  return UpdateStatusResponse.parse(await res.json())
}

describe("GET /settings/api/update-status", () => {
  let fetchCalls: number
  let version: string
  let clock: number

  beforeEach(() => {
    fetchCalls = 0
    version = "v999.0.0"
    clock = 1_000_000
    __resetUpdateCheckDepsForTests()
    __setUpdateCheckDepsForTests({
      fetch: () => {
        fetchCalls++
        return Promise.resolve(manifest(version))
      },
      now: () => clock,
      currentVersion: "0.5.0",
      aptInstall: null,
    })
  })
  afterEach(() => {
    __resetUpdateCheckDepsForTests()
  })

  test("serves the cached check without ?force", async () => {
    const first = await get()
    version = "v1000.0.0"
    clock += FORCE_MIN_INTERVAL_MS
    const second = await get()
    expect(fetchCalls).toBe(1)
    expect(second.latest).toBe(first.latest)
  })

  test("?force=1 skips the cache and fetches again", async () => {
    await get()
    version = "v1000.0.0"
    clock += FORCE_MIN_INTERVAL_MS
    const forced = await get("?force=1")
    expect(fetchCalls).toBe(2)
    expect(forced.latest).toBe("1000.0.0")
    expect(forced.update_available).toBe(true)
  })

  test("?force=1 is rate limited to one fetch per window", async () => {
    await get("?force=1")
    version = "v1000.0.0"
    clock += 1000
    const again = await get("?force=1")
    expect(fetchCalls).toBe(1)
    expect(again.latest).toBe("999.0.0")
  })

  test("only force=1 forces", async () => {
    await get()
    clock += FORCE_MIN_INTERVAL_MS
    await get("?force=0")
    await get("?force=true")
    await get("?force=")
    expect(fetchCalls).toBe(1)
  })

  test("a forced response has the same shape as an unforced one", async () => {
    const plain = await get()
    clock += FORCE_MIN_INTERVAL_MS
    const forced = await get("?force=1")
    expect(Object.keys(forced).sort()).toEqual(Object.keys(plain).sort())
  })
})
