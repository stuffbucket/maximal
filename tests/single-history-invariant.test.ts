import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

/**
 * Single-history grep gate (spec §1.4, ADR-0020, §10 "Single-history grep").
 *
 * A stale-tab `window.close()` silently no-ops the moment `history.length > 1`, so
 * the routing sources must NEVER `pushState` or assign `location.hash`. This greps
 * the source (the repo tests DOM glue by text — there is no jsdom harness) so a
 * regression reds CI at commit time. Runs LIVE now.
 *
 * Scope note (§7): `shell/src/main.ts` is now in scope — its nav goes through
 * `history.replaceState` (never `location.hash =`). `shell/src/dashboard/main.ts:337`'s
 * `history.pushState` is still OUT of scope; it joins this ban when the dashboard
 * is ported into the SPA (§4). Add it to ROUTING_SOURCES then.
 */

const REPO_ROOT = resolve(import.meta.dir, "..")

const ROUTING_SOURCES = [
  "shell/src/router.ts",
  "shell/src/router-bootstrap.ts",
  "shell/src/proxy/live-feed-client.ts",
  "shell/src/proxy/live-feed-core.ts",
  "shell/src/main.ts",
]

function read(rel: string): string {
  return readFileSync(resolve(REPO_ROOT, rel), "utf8")
}

/** Strip line/block comments so bans target executable code, not documentation. */
function stripComments(source: string): string {
  return source.replaceAll(/\/\*[\s\S]*?\*\//g, "").replaceAll(/\/\/.*$/gm, "")
}

describe("single-history routing invariant (source grep)", () => {
  for (const rel of ROUTING_SOURCES) {
    test(`${rel} never calls pushState`, () => {
      const code = stripComments(read(rel))
      expect(
        code.includes("pushState"),
        `${rel} must not call history.pushState (ADR-0020)`,
      ).toBe(false)
    })

    test(`${rel} never assigns location.hash`, () => {
      const code = stripComments(read(rel))
      // Bans `location.hash =` / `.hash =` assignment (not read access).
      expect(
        /\.hash\s*=/.test(code),
        `${rel} must not assign location.hash (ADR-0020)`,
      ).toBe(false)
    })
  }

  test("the router core routes through replaceState", () => {
    // Positive assertion: the invariant is upheld by using replaceState somewhere.
    expect(read("shell/src/router.ts").includes("replaceState")).toBe(true)
  })
})
