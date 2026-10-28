/**
 * The async runner and npm's cached global prefix. The prefix lookup is
 * injected (no real npm); runFile runs real, trivial programs.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import {
  __resetNpmPrefixForTests,
  __setNpmPrefixDepsForTests,
  cachedNpmGlobalPrefix,
  npmGlobalPrefix,
  type RunResult,
  runFile,
} from "~/lib/system/run-file"

const ok = (stdout: string): RunResult => ({
  stdout,
  stderr: "",
  code: 0,
  notFound: false,
})

// Reset before each test too: an earlier file (runServer warms the prefix)
// can leave a real cached or in-flight `npm prefix -g` behind.
beforeEach(() => {
  __resetNpmPrefixForTests()
})

afterEach(() => {
  __resetNpmPrefixForTests()
})

describe("runFile", () => {
  test("reports output and exit code without throwing", async () => {
    const result = await runFile(
      "sh",
      ["-c", "echo out; echo err >&2; exit 3"],
      {
        timeoutMs: 5000,
      },
    )
    expect(result).toEqual({
      stdout: "out\n",
      stderr: "err\n",
      code: 3,
      notFound: false,
    })
  })

  test("reports a missing program as notFound", async () => {
    const result = await runFile("maximal-no-such-program", [], {
      timeoutMs: 5000,
    })
    expect(result.notFound).toBe(true)
  })

  test("keeps the event loop free while the child runs", async () => {
    let ticked = false
    setTimeout(() => {
      ticked = true
    }, 0)
    const child = runFile("sh", ["-c", "sleep 0.3"], { timeoutMs: 5000 })
    await Bun.sleep(50)
    // A synchronous spawn would have held the timer until the child exited.
    expect(ticked).toBe(true)
    expect((await child).code).toBe(0)
  })
})

describe("npmGlobalPrefix", () => {
  test("concurrent callers share one spawn, and a found prefix is kept", async () => {
    let spawns = 0
    let now = 0
    __setNpmPrefixDepsForTests({
      run: () => {
        spawns++
        return Promise.resolve(ok("/usr/local\n"))
      },
      now: () => now,
    })

    expect(cachedNpmGlobalPrefix()).toBeUndefined()
    const [a, b] = await Promise.all([npmGlobalPrefix(), npmGlobalPrefix()])
    expect([a, b]).toEqual(["/usr/local", "/usr/local"])
    expect(cachedNpmGlobalPrefix()).toBe("/usr/local")

    now += 24 * 60 * 60 * 1000
    expect(await npmGlobalPrefix()).toBe("/usr/local")
    expect(spawns).toBe(1)
  })

  test("a miss is retried after a minute", async () => {
    let spawns = 0
    let now = 0
    let installed = false
    __setNpmPrefixDepsForTests({
      run: () => {
        spawns++
        return Promise.resolve(
          installed ?
            ok("/opt/node\n")
          : { ...ok(""), code: 127, notFound: true },
        )
      },
      now: () => now,
    })

    expect(await npmGlobalPrefix()).toBeNull()
    installed = true
    now += 30_000
    expect(await npmGlobalPrefix()).toBeNull()
    expect(spawns).toBe(1)

    now += 31_000
    expect(await npmGlobalPrefix()).toBe("/opt/node")
    expect(spawns).toBe(2)
  })

  test("a lookup orphaned by a reset doesn't fill the fresh cache", async () => {
    const orphan = Promise.withResolvers<RunResult>()
    __setNpmPrefixDepsForTests({ run: () => orphan.promise })
    const orphaned = npmGlobalPrefix()

    __resetNpmPrefixForTests()
    let spawns = 0
    __setNpmPrefixDepsForTests({
      run: () => {
        spawns++
        return Promise.resolve(ok("/fresh\n"))
      },
    })
    const fresh = npmGlobalPrefix()

    orphan.resolve(ok("/stale\n"))
    expect(await orphaned).toBe("/stale")
    expect(await fresh).toBe("/fresh")
    expect(cachedNpmGlobalPrefix()).toBe("/fresh")
    expect(spawns).toBe(1)
  })
})
