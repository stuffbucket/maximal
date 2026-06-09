import { describe, test, expect, mock } from "bun:test"

import {
  evictRunning,
  looksLikeMaximalCommand,
} from "../src/lib/replace-running"

/**
 * Tests for the --replace eviction flow. Everything is driven through
 * the injectable seams on evictRunning() so we never bind real sockets
 * or touch the real filesystem.
 */

describe("looksLikeMaximalCommand (the kill-no-stranger guard)", () => {
  test.each([
    ["/Users/brian/.local/bin/maximal start --port 4141", true],
    [
      "/Applications/Maximal.app/Contents/MacOS/maximal start --replace --port 4141",
      true,
    ],
    ["/opt/homebrew/bin/maximal", true],
    ["maximal start", true],
    ["MAXIMAL START", true], // case-insensitive
    ["maximal", true], // bare binary name, no args — matches via ^…$
    ["  maximal  ", true], // bare name + whitespace — needs both trim AND ^…$
  ])("treats %p as a maximal proxy", (cmd, expected) => {
    expect(looksLikeMaximalCommand(cmd)).toBe(expected)
  })

  test.each([
    // The menu-bar app — killing it would be wrong.
    ["/Applications/Maximal.app/Contents/MacOS/maximal-shell", false],
    // Unrelated processes that merely contain the substring.
    ["/usr/bin/maximalist-editor", false],
    ["node /some/maximalism/server.js", false],
    ["python3 -m maximalize", false],
    ["", false],
    ["   ", false],
  ])("refuses to claim %p", (cmd, expected) => {
    expect(looksLikeMaximalCommand(cmd)).toBe(expected)
  })
})

function urlString(input: string | URL | Request): string {
  if (typeof input === "string") return input
  if (input instanceof URL) return input.href
  return input.url
}

describe("evictRunning", () => {
  test("no instance running → resolves without POST", async () => {
    let postCount = 0
    const fetchImpl = mock((input: string | URL | Request) => {
      const u = urlString(input)
      if (u.endsWith("/setup-status")) {
        // Simulate connect-refused.
        return Promise.reject(new Error("ECONNREFUSED"))
      }
      postCount++
      return Promise.resolve(new Response(null, { status: 202 }))
    }) as unknown as typeof fetch

    await evictRunning({
      apiKey: "k",
      probePort: () => Promise.resolve(false),
      readPidfile: () => Promise.resolve(null),
      sleep: () => Promise.resolve(),
      kill: () => {},
      fetchImpl,
    })

    expect(postCount).toBe(0)
  })

  test("shutdown 202 then port closes within deadline → resolves cleanly", async () => {
    let postCalls = 0
    let probes = 0

    const fetchImpl = mock((input: string | URL | Request) => {
      const u = urlString(input)
      if (u.endsWith("/setup-status")) {
        return Promise.resolve(new Response("{}", { status: 200 }))
      }
      if (u.endsWith("/_internal/shutdown")) {
        postCalls++
        return Promise.resolve(
          new Response(JSON.stringify({ ok: true }), { status: 202 }),
        )
      }
      return Promise.resolve(new Response(null, { status: 404 }))
    }) as unknown as typeof fetch

    let killCalls = 0

    await evictRunning({
      apiKey: "secret-key",
      probePort: () => {
        probes++
        // Held on first probe, then released.
        return Promise.resolve(probes < 2)
      },
      readPidfile: () => Promise.resolve(null),
      sleep: () => Promise.resolve(),
      kill: () => {
        killCalls++
      },
      fetchImpl,
    })

    expect(postCalls).toBe(1)
    expect(killCalls).toBe(0)
    expect(probes).toBeGreaterThanOrEqual(1)
  })

  test("shutdown accepted but port held → SIGTERM then SIGKILL", async () => {
    const fetchImpl = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify({ ok: true }), { status: 202 }),
      ),
    ) as unknown as typeof fetch

    const signals: Array<NodeJS.Signals | 0> = []
    const kill = (_pid: number, sig: NodeJS.Signals | 0): void => {
      signals.push(sig)
    }

    // Probe says "held" during the drain loop. After SIGKILL is sent,
    // the final port probe returns false so eviction succeeds.
    const probePort = (): Promise<boolean> => {
      if (signals.includes("SIGKILL")) return Promise.resolve(false)
      return Promise.resolve(true)
    }

    // Tight virtual clock — each call advances 60ms to exceed the
    // 300ms drain deadline quickly.
    let t = 0
    const now = (): number => {
      const v = t
      t += 60
      return v
    }

    await evictRunning({
      apiKey: "k",
      probePort,
      readPidfile: () => Promise.resolve(4242),
      sleep: () => Promise.resolve(),
      kill,
      fetchImpl,
      now,
      drainTimeoutMs: 300,
      killEscalationMs: 10,
    })

    expect(signals[0]).toBe("SIGTERM")
    // kill(pid, 0) liveness probe in the middle…
    expect(signals.includes(0)).toBe(true)
    // …then SIGKILL.
    expect(signals.includes("SIGKILL")).toBe(true)
  })

  test("CLI exposes --replace flag", async () => {
    // Import the citty command and verify the arg is registered. We do
    // NOT invoke run() — that would spin the real server.
    const { start } = await import("../src/start")
    const args = (
      start as unknown as { args: Record<string, { type: string }> }
    ).args
    expect(args.replace).toBeDefined()
    expect(args.replace.type).toBe("boolean")
  })

  test("stale pidfile + live listener → evicts the real port holder", async () => {
    // Repro of the v0.4.14 "sidecar failed to start" report: the pidfile
    // names a dead PID (its SIGTERM is a no-op), but a different, live
    // maximal still holds the port. We must discover and reap THAT pid,
    // not give up on the stale pidfile.
    const fetchImpl = mock(() =>
      Promise.resolve(new Response("{}", { status: 404 })),
    ) as unknown as typeof fetch

    const killed: Array<{ pid: number; sig: NodeJS.Signals | 0 }> = []
    const STALE = 55355
    const LIVE = 57198

    await evictRunning({
      apiKey: "k",
      // Held until the LIVE pid gets SIGKILL'd.
      probePort: () =>
        Promise.resolve(
          !killed.some((k) => k.pid === LIVE && k.sig === "SIGKILL"),
        ),
      readPidfile: () => Promise.resolve(STALE),
      // Stale pid is already dead: its liveness probe (signal 0) throws.
      kill: (pid, sig) => {
        if (pid === STALE && sig === 0) throw new Error("ESRCH")
        killed.push({ pid, sig })
      },
      listenerPid: () => LIVE,
      sleep: () => Promise.resolve(),
      now: (() => {
        let t = 0
        return () => (t += 60)
      })(),
      drainTimeoutMs: 120,
      killEscalationMs: 10,
      fetchImpl,
    })

    // The real holder was SIGKILL'd; the stale pid got only its no-op SIGTERM.
    expect(killed.some((k) => k.pid === LIVE && k.sig === "SIGKILL")).toBe(true)
    expect(killed.some((k) => k.pid === STALE && k.sig === "SIGKILL")).toBe(
      false,
    )
  })

  test("HTTP unreachable but port still held → still proceeds to kill", async () => {
    // An older instance whose /setup-status 404s on connect-refuse, or one
    // wedged before it serves: requestShutdown reports unreachable, but the
    // port is held. We must NOT early-return — that left the holder running.
    const fetchImpl = mock(() =>
      Promise.reject(new Error("ECONNREFUSED")),
    ) as unknown as typeof fetch

    const killed: Array<NodeJS.Signals | 0> = []

    await evictRunning({
      apiKey: "k",
      probePort: () => Promise.resolve(!killed.includes("SIGKILL")),
      readPidfile: () => Promise.resolve(4242),
      kill: (_pid, sig) => {
        killed.push(sig)
      },
      listenerPid: () => null,
      sleep: () => Promise.resolve(),
      killEscalationMs: 10,
      fetchImpl,
    })

    expect(killed.includes("SIGTERM")).toBe(true)
    expect(killed.includes("SIGKILL")).toBe(true)
  })
})
