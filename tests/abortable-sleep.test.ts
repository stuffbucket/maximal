import { describe, expect, test } from "bun:test"

import { abortableSleep } from "~/lib/platform/utils"

/**
 * `abortableSleep` underpins the cancellable poll: an abort must resolve a
 * pending wait immediately rather than letting it run to term. Assertions are
 * upper-bounds only (resolves *fast* on abort) so they hold whether the real
 * timer runs or a sibling test has stubbed the module — the "does it wait the
 * full delay" half is just `setTimeout` and not worth a leak-fragile assertion.
 */
describe("abortableSleep", () => {
  test("resolves without waiting when the signal is already aborted", async () => {
    const c = new AbortController()
    c.abort()
    const start = performance.now()
    await abortableSleep(60_000, c.signal)
    expect(performance.now() - start).toBeLessThan(500)
  })

  test("an abort resolves a pending sleep instead of waiting it out", async () => {
    const c = new AbortController()
    const start = performance.now()
    const done = abortableSleep(60_000, c.signal)
    setTimeout(() => c.abort(), 10)
    await done
    expect(performance.now() - start).toBeLessThan(1000)
  })
})
