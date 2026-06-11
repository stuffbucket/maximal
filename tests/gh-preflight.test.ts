import { describe, expect, test } from "bun:test"

import { preflightCopilotError } from "~/lib/copilot-preflight"
import { HTTPError } from "~/lib/error"

const ok = () => Promise.resolve({ copilot_plan: "enterprise" })
const throwsHttp = (status: number) => () =>
  Promise.reject(new HTTPError("x", new Response(null, { status })))

describe("preflightCopilotError", () => {
  test("returns null when the token works for Copilot", async () => {
    expect(await preflightCopilotError("gho_x", "alice", ok)).toBeNull()
  })

  test("401 → expired/revoked, names the account", async () => {
    const msg = await preflightCopilotError("gho_x", "alice", throwsHttp(401))
    expect(msg).toContain("expired or revoked")
    expect(msg).toContain("alice")
  })

  test("403 / 404 → no Copilot subscription", async () => {
    for (const status of [403, 404]) {
      const msg = await preflightCopilotError(
        "gho_x",
        "bob",
        throwsHttp(status),
      )
      expect(msg).toContain("doesn't have access to GitHub Copilot")
    }
  })

  test("other status → generic verify message including the status", async () => {
    const msg = await preflightCopilotError("gho_x", "carol", throwsHttp(503))
    expect(msg).toContain("Couldn't verify")
    expect(msg).toContain("503")
  })

  test("non-HTTP error (network) → generic verify message", async () => {
    const msg = await preflightCopilotError("gho_x", "carol", () =>
      Promise.reject(new Error("network down")),
    )
    expect(msg).toContain("Couldn't verify")
  })
})
