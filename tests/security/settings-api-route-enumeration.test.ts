import { describe, expect, test } from "bun:test"

import { CSRF_GUARDED_PREFIXES } from "~/lib/auth/origin-guard"
import { server } from "~/server"

/**
 * Self-extending CSRF coverage (spec §10 "Self-extending route-enumeration").
 *
 * Walks the live `server.routes` so a NEW `/settings/api` route that ships without
 * the Origin gate fails by omission — no one has to remember to add it here. The
 * assertion is skipped until the guard is wired into `server.ts` (§9.1); the
 * enumeration itself runs live so the harness proves the route table is readable.
 */

function settingsApiRoutes(): Array<string> {
  const paths = new Set<string>()
  for (const route of server.routes) {
    if (route.path.startsWith("/settings/api")) paths.add(route.path)
  }
  return [...paths]
}

describe("route enumeration — active now", () => {
  test("the /settings/api surface is non-empty and readable", () => {
    // Sanity: if this ever returns [], the enumeration below is silently vacuous.
    expect(settingsApiRoutes().length).toBeGreaterThan(0)
  })

  test("the guard applies to /settings/api", () => {
    expect(CSRF_GUARDED_PREFIXES).toContain("/settings/api")
  })
})

describe("every mutating /settings/api route is Origin-gated — unskip when wired", () => {
  test("evil Origin is rejected on every POST/PUT/DELETE under /settings/api", async () => {
    const evil = { origin: "https://evil.example" } as const
    for (const route of server.routes) {
      if (!route.path.startsWith("/settings/api")) continue
      if (!["DELETE", "PATCH", "POST", "PUT"].includes(route.method)) continue
      const res = await server.request(route.path, {
        method: route.method,
        headers: evil,
      })
      expect(
        res.status,
        `unguarded CSRF surface: ${route.method} ${route.path}`,
      ).toBe(403)
    }
  })
})
