import { describe, expect, test } from "bun:test"

import type { McpServerConfig } from "~/lib/config/config"
import type { WorkIqRunner } from "~/lib/system/workiq-cli"

import { WorkIq, type WorkIqDeps, workIqState } from "~/lib/mcp-broker/workiq"

const server: McpServerConfig = {
  id: "workiq",
  label: "Work IQ",
  enabled: true,
  catalog: "workiq",
  transport: {
    type: "stdio",
    command: "/opt/workiq/bin/workiq",
    args: ["mcp"],
  },
  environment: { inherit: ["HOME"] },
}

const LOCAL = ["accept_eula", "ask", "list_agents"]
const SIGNED_IN = [...LOCAL, "fetch", "get_schema", "search_paths"]

describe("workIqState", () => {
  const base = {
    installed: true,
    eulaAccepted: true,
    signedInBefore: true,
    brokerReady: true,
    tools: SIGNED_IN,
  }

  test("walks the steps in order", () => {
    expect(workIqState({ ...base, installed: false })).toBe("not-installed")
    expect(workIqState({ ...base, eulaAccepted: false })).toBe("eula-needed")
    expect(workIqState({ ...base, signedInBefore: false })).toBe(
      "signin-needed",
    )
    expect(workIqState({ ...base, brokerReady: false })).toBe("starting")
    expect(workIqState({ ...base, tools: undefined })).toBe("starting")
    expect(workIqState(base)).toBe("ready")
  })

  test("signed in with only the local tools means the organization hasn't approved it", () => {
    expect(workIqState({ ...base, tools: LOCAL })).toBe("consent-needed")
    expect(workIqState({ ...base, tools: [] })).toBe("consent-needed")
  })
})

interface Call {
  args: Array<string>
  env: Record<string, string> | undefined
  timeoutMs: number | undefined
}

/** A fake `workiq` whose config is `config` and whose commands answer as
 *  `answer` says (default: exit 0). */
function fakeWorkIq(
  config: Record<string, string>,
  answer: (
    args: Array<string>,
    signal: AbortSignal | undefined,
  ) =>
    | Promise<{ code: number; stderr?: string; outcome?: string }>
    | undefined = () => undefined,
) {
  const calls: Array<Call> = []
  const run: WorkIqRunner = async (_executable, args, options) => {
    calls.push({ args, env: options.env, timeoutMs: options.timeoutMs })
    const custom = await answer(args, options.signal)
    if (args[0] === "config" && args[1] === "show") {
      return {
        stdout: Object.entries(config)
          .map(([key, value]) => `${key}=${value}`)
          .join("\n"),
        stderr: "",
        code: 0,
        outcome: "exited",
      }
    }
    if (args[0] === "accept-eula") config["I-accept-EULA"] = "true"
    if (args[0] === "config" && args[1] === "set") {
      config.disableBrokeredAuth = "true"
    }
    if (args[0] === "auth" && (custom?.code ?? 0) === 0) {
      config.defaultAccount = "someone@example.com"
    }
    return {
      stdout: "",
      stderr: custom?.stderr ?? "",
      code: custom?.code ?? 0,
      outcome: (custom?.outcome ?? "exited") as "exited",
    }
  }
  return { calls, run, config }
}

function harness(
  fake: ReturnType<typeof fakeWorkIq>,
  overrides: Partial<WorkIqDeps> = {},
) {
  const events: Array<string> = []
  const problems = new Map<string, { line: string; at: number }>()
  const deps: WorkIqDeps = {
    run: fake.run,
    restartBroker: () => {
      events.push("restart")
      return Promise.resolve(true)
    },
    waitForBroker: () => {
      events.push("wait")
      return Promise.resolve("ready")
    },
    brokerState: () => "ready",
    endpointTools: () => SIGNED_IN,
    log: {
      lastProblem: (id) => problems.get(id),
      forget: (id) => {
        events.push(`forget:${id}`)
        problems.delete(id)
      },
    },
    platform: "darwin",
    env: { HOME: "/Users/someone", PATH: "/usr/bin:/bin", GITHUB_TOKEN: "x" },
    ...overrides,
  }
  return { workiq: new WorkIq(deps), events, problems }
}

describe("WorkIq.status", () => {
  test("combines Work IQ's config with what the running broker sees", async () => {
    const fake = fakeWorkIq({ "I-accept-EULA": "true", defaultAccount: "a@b" })
    const { workiq, problems } = harness(fake, { endpointTools: () => LOCAL })
    problems.set("workiq", {
      line: "[MCP Proxy] Failed to fetch remote tools: Forbidden",
      at: 1,
    })
    expect(await workiq.status(server)).toEqual({
      state: "consent-needed",
      eulaAccepted: true,
      signedInBefore: true,
      browserSignIn: false,
      macos: true,
      signIn: "idle",
      lastProblem: "[MCP Proxy] Failed to fetch remote tools: Forbidden",
    })
    expect(fake.calls.map((call) => call.args)).toEqual([["config", "show"]])
  })

  test("never passes Maximal's secrets to Work IQ", async () => {
    const fake = fakeWorkIq({})
    await harness(fake).workiq.status(server)
    expect(fake.calls[0]?.env).toMatchObject({ HOME: "/Users/someone" })
    expect(fake.calls[0]?.env).not.toHaveProperty("GITHUB_TOKEN")
  })

  test("needs the EULA first, and says so off macOS too", async () => {
    const { workiq } = harness(fakeWorkIq({}), { platform: "linux" })
    expect(await workiq.status(server)).toMatchObject({
      state: "eula-needed",
      macos: false,
    })
  })

  test("is starting while the broker isn't serving", async () => {
    const fake = fakeWorkIq({ "I-accept-EULA": "true", defaultAccount: "a@b" })
    const { workiq } = harness(fake, {
      brokerState: () => "starting",
      endpointTools: () => undefined,
    })
    expect((await workiq.status(server)).state).toBe("starting")
  })
})

describe("WorkIq.acceptEula", () => {
  test("runs accept-eula and nothing else that changes Work IQ", async () => {
    const fake = fakeWorkIq({})
    const { workiq, events } = harness(fake)
    expect(await workiq.acceptEula(server)).toEqual({ ok: true })
    expect(fake.calls.map((call) => call.args)).toEqual([
      ["accept-eula"],
      ["config", "show"],
    ])
    // Not signed in yet, so there's nothing new for the broker to see.
    expect(events).not.toContain("restart")
  })

  test("restarts Work IQ when an earlier sign-in can now be used", async () => {
    const fake = fakeWorkIq({ defaultAccount: "a@b" })
    const { workiq, events } = harness(fake)
    expect(await workiq.acceptEula(server)).toEqual({ ok: true })
    expect(events).toContain("restart")
  })

  test("reports what Work IQ said when it fails", async () => {
    const fake = fakeWorkIq({}, (args) =>
      args[0] === "accept-eula" ?
        Promise.resolve({ code: 1, stderr: "first\nCould not save config\n" })
      : undefined,
    )
    const { workiq } = harness(fake)
    expect(await workiq.acceptEula(server)).toEqual({
      ok: false,
      problem: "Could not save config",
    })
  })
})

describe("WorkIq sign-in", () => {
  test("signs in, then restarts Work IQ so it's probed again", async () => {
    const fake = fakeWorkIq({ "I-accept-EULA": "true" })
    const { workiq, events } = harness(fake)
    const { finished } = workiq.startSignIn(server, { useBrowserSignIn: false })
    await finished
    expect(fake.calls.map((call) => call.args)).toEqual([
      ["auth", "login"],
      ["config", "show"],
    ])
    expect(fake.calls[0]?.timeoutMs).toBe(5 * 60_000)
    expect(events).toEqual(["forget:workiq", "restart", "wait"])
    expect(await workiq.status(server)).toMatchObject({
      state: "ready",
      signIn: "idle",
    })
  })

  test("switches to browser sign-in first only when asked", async () => {
    const fake = fakeWorkIq({ "I-accept-EULA": "true" })
    const { workiq } = harness(fake)
    await workiq.startSignIn(server, { useBrowserSignIn: true }).finished
    expect(fake.calls.map((call) => call.args).slice(0, 2)).toEqual([
      ["config", "set", "disableBrokeredAuth=true"],
      ["auth", "login"],
    ])
    expect((await workiq.status(server)).browserSignIn).toBe(true)
  })

  test("a second request while one runs doesn't start another", async () => {
    let release!: () => void
    const fake = fakeWorkIq({ "I-accept-EULA": "true" }, (args) =>
      args[0] === "auth" ?
        new Promise((resolve) => {
          release = () => resolve({ code: 0 })
        })
      : undefined,
    )
    const { workiq } = harness(fake)
    const first = workiq.startSignIn(server, { useBrowserSignIn: false })
    await Bun.sleep(5)
    expect((await workiq.status(server)).signIn).toBe("waiting")
    expect(
      workiq.startSignIn(server, { useBrowserSignIn: false }).started,
    ).toBe(false)
    release()
    await first.finished
    expect(fake.calls.filter((call) => call.args[0] === "auth")).toHaveLength(1)
  })

  test("cancelling stops the sign-in and restarts nothing", async () => {
    const fake = fakeWorkIq({ "I-accept-EULA": "true" }, (args, signal) =>
      args[0] === "auth" ?
        new Promise((resolve) => {
          signal?.addEventListener("abort", () =>
            resolve({ code: 1, outcome: "cancelled" }),
          )
        })
      : undefined,
    )
    const { workiq, events } = harness(fake)
    const { finished } = workiq.startSignIn(server, { useBrowserSignIn: false })
    await Bun.sleep(5)
    expect(workiq.cancelSignIn("workiq")).toBe(true)
    await finished
    expect(events).not.toContain("restart")
    expect((await workiq.status(server)).signIn).toBe("cancelled")
    expect(workiq.cancelSignIn("workiq")).toBe(false)
  })

  test("a failed sign-in keeps Work IQ's last word for the card", async () => {
    const fake = fakeWorkIq({ "I-accept-EULA": "true" }, (args) =>
      args[0] === "auth" ?
        Promise.resolve({
          code: 1,
          stderr: "AADSTS50011: The redirect URI does not match.\n",
        })
      : undefined,
    )
    const { workiq, events } = harness(fake)
    await workiq.startSignIn(server, { useBrowserSignIn: false }).finished
    expect(events).not.toContain("restart")
    expect(await workiq.status(server)).toMatchObject({
      state: "signin-needed",
      signIn: "failed",
      lastProblem: "AADSTS50011: The redirect URI does not match.",
    })
  })

  test("a sign-in that runs out of time says so", async () => {
    const fake = fakeWorkIq({ "I-accept-EULA": "true" }, (args) =>
      args[0] === "auth" ?
        Promise.resolve({ code: 1, outcome: "timed-out" })
      : undefined,
    )
    const { workiq } = harness(fake)
    await workiq.startSignIn(server, { useBrowserSignIn: false }).finished
    expect((await workiq.status(server)).signIn).toBe("timed-out")
  })
})
