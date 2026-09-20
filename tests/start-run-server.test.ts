/**
 * `runServer` argument → state translation, in-process.
 *
 * The existing tests/start-unauthenticated.test.ts spawns a real
 * subprocess and only validates the no-token boot path. That leaves
 * the CLI-args-to-state mapping (the `run({ args }) { return
 * runServer({ ... }) }` block) and the per-option branches inside
 * runServer untested — see the ~30 ConditionalExpression survivors
 * around `options.accountType !== "individual"`, the verbose branch,
 * the proxyEnv branch, the bootstrapUpstream("override" vs disk)
 * branch, and the claude-code helper guard.
 *
 * To exercise those in-process without binding a real port or
 * touching the GitHub device-code flow we mock every side-effecting
 * dependency runServer pulls in. The mocks form a "test harness
 * runServer": deterministic, fast, no listeners leaked.
 */
import {
  afterAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
  type Mock,
} from "bun:test"

// --- Mocks for the chunky boot dependencies ------------------------

const initOpencodeVersionMock = mock(() => Promise.resolve())
const realOpencodeModule = await import("~/lib/platform/opencode")
await mock.module("~/lib/platform/opencode", () => ({
  ...realOpencodeModule,
  initOpencodeVersion: initOpencodeVersionMock,
}))

// `~/lib/platform/paths` is shared by `~/lib/config/config`, `~/lib/platform/logger`, and the
// real `~/server` — we keep its PATHS map intact and only stub
// `ensurePaths` so the test never touches disk.
const ensurePathsMock = mock(() => Promise.resolve())
const realPathsModule = await import("~/lib/platform/paths")
await mock.module("~/lib/platform/paths", () => ({
  ...realPathsModule,
  ensurePaths: ensurePathsMock,
}))

const initProxyFromEnvMock = mock(() => {})
const realProxyModule = await import("~/lib/http/proxy")
await mock.module("~/lib/http/proxy", () => ({
  ...realProxyModule,
  initProxyFromEnv: initProxyFromEnvMock,
}))

const ensureSecretsDirMock = mock(() => {})
const loadSecretIntoEnvMock = mock(() => ({ source: "unset" as const }))
const realSecretsModule = await import("~/lib/auth/secrets")
await mock.module("~/lib/auth/secrets", () => ({
  ...realSecretsModule,
  ensureSecretsDir: ensureSecretsDirMock,
  loadSecretIntoEnv: loadSecretIntoEnvMock,
  SECRET_DEFS: [] as Array<unknown>,
}))

const cacheModelsMock = mock(() => Promise.resolve())
const cacheVSCodeVersionMock = mock(() => Promise.resolve())
const cacheMacMachineIdMock = mock(() => {})
const cacheVsCodeSessionIdMock = mock(() => {})
const cacheVsCodeDeviceIdMock = mock(() => Promise.resolve())
const realUtilsModule = await import("~/lib/platform/utils")
await mock.module("~/lib/platform/utils", () => ({
  ...realUtilsModule,
  cacheModels: cacheModelsMock,
  cacheVSCodeVersion: cacheVSCodeVersionMock,
  cacheMacMachineId: cacheMacMachineIdMock,
  cacheVsCodeSessionId: cacheVsCodeSessionIdMock,
  cacheVsCodeDeviceId: cacheVsCodeDeviceIdMock,
}))

const logUserMock = mock(() => {
  // The real logUser() populates state.userName as part of its contract.
  // Mirror that here so the cold-boot path (which now requires a real
  // login before flipping to authenticated — ADR-0006) sees a populated
  // userName and reaches markSignedIn("alice"). Tests that need a
  // different login override this via logUserMock.mockImplementation.
  state.userName = "alice"
  return Promise.resolve()
})
const setupCopilotTokenMock = mock(() => Promise.resolve())
const realTokenModule = await import("~/lib/auth/token")
await mock.module("~/lib/auth/token", () => ({
  ...realTokenModule,
  logUser: logUserMock,
  setupCopilotToken: setupCopilotTokenMock,
}))

let storedRecord: { accessToken: string } | null = null
const readDefaultRecordMock = mock(() => Promise.resolve(storedRecord))
const realStoreModule = await import("~/lib/auth/github-token-store")
await mock.module("~/lib/auth/github-token-store", () => ({
  ...realStoreModule,
  readDefaultRecord: readDefaultRecordMock,
}))

// Don't mock `~/lib/config/config` — its real `mergeConfigWithDefaults` is a
// safe no-op on a missing config file, and `~/server` (loaded by the
// dynamic import in runServer) needs the rest of its exports.

// Boot logger: capture log messages so we can assert format.
const bootLogMessages: Array<string> = []
const fakeLogger = {
  info: (msg: string) => bootLogMessages.push(msg),
  warn: () => {},
  error: () => {},
  debug: () => {},
}
const realLoggerModule = await import("~/lib/platform/logger")
await mock.module("~/lib/platform/logger", () => ({
  ...realLoggerModule,
  createHandlerLogger: () => fakeLogger,
}))

// Stub `serve` from srvx so runServer never binds a port.
const serveMock = mock(() => ({ close: () => Promise.resolve() }))
const realSrvxModule = await import("srvx")
await mock.module("srvx", () => ({ ...realSrvxModule, serve: serveMock }))

// NOTE: we deliberately don't mock `~/server`. Replacing the cached
// module with a stub Hono leaks into other test files (e.g.
// tests/debug-route.test.ts) that share the same `bun test` process.
// The real server module is cheap to import and `serve()` is mocked
// below so no port actually binds.

// Force probePort -> "free" so runServer proceeds past the EADDRINUSE
// guard without making any outbound HTTP requests.
const realFetch = globalThis.fetch
globalThis.fetch = (() =>
  Promise.reject(
    new Error("network disabled in test"),
  )) as unknown as typeof fetch

// --- Module under test (imported after mocks are wired) -----------

const { state } = await import("~/lib/runtime-state/state")
const { runServer, start } = await import("~/start")
const { getAuthStatus, signOut, __resetAuthControllerForTests } =
  await import("~/lib/auth/auth-controller")
const { CopilotAuthFatalError } = await import("~/lib/errors/error")

function resetState(): void {
  // Reset auth-controller module state (authState, the degrade single-flight /
  // grace window, and the auto-recovery hook) so a sibling test file's recent
  // markSignedIn / registered recovery can't leak in and suppress a boot degrade.
  __resetAuthControllerForTests()
  state.githubToken = undefined
  state.userName = undefined
  state.copilotToken = undefined
  state.accountType = "individual"
  state.manualApprove = false
  state.rateLimitWait = false
  state.showToken = false
  state.verbose = false
  state.rateLimitSeconds = undefined
  bootLogMessages.length = 0
  storedRecord = null
  serveMock.mockClear()
  initProxyFromEnvMock.mockClear()
  logUserMock.mockClear()
  setupCopilotTokenMock.mockClear()
  cacheModelsMock.mockClear()
}

function pickFreePort(): number {
  return 41000 + Math.floor(Math.random() * 1000)
}

function baseOptions(
  over: Partial<Parameters<typeof runServer>[0]> = {},
): Parameters<typeof runServer>[0] {
  return {
    port: pickFreePort(),
    verbose: false,
    accountType: "individual",
    manual: false,
    rateLimit: undefined as number | undefined,
    rateLimitWait: false,
    githubToken: undefined as string | undefined,
    claudeCode: false,
    showToken: false,
    proxyEnv: false,
    replace: false,
    ...over,
  }
}

beforeEach(() => {
  resetState()
})

describe("runServer — state mutation from options", () => {
  test("verbose=true sets state.verbose and bumps consola.level", async () => {
    await runServer(baseOptions({ verbose: true }))
    expect(state.verbose).toBe(true)
  })

  test("verbose=false leaves state.verbose false", async () => {
    await runServer(baseOptions({ verbose: false }))
    expect(state.verbose).toBe(false)
  })

  test("accountType=business lands in state.accountType", async () => {
    await runServer(baseOptions({ accountType: "business" }))
    expect(state.accountType).toBe("business")
  })

  test("accountType=enterprise lands in state.accountType", async () => {
    await runServer(baseOptions({ accountType: "enterprise" }))
    expect(state.accountType).toBe("enterprise")
  })

  test("accountType=individual is the default-shaped path", async () => {
    await runServer(baseOptions({ accountType: "individual" }))
    expect(state.accountType).toBe("individual")
  })

  test("manual=true flips state.manualApprove", async () => {
    await runServer(baseOptions({ manual: true }))
    expect(state.manualApprove).toBe(true)
  })

  test("rateLimit=5 lands in state.rateLimitSeconds", async () => {
    await runServer(baseOptions({ rateLimit: 5 }))
    expect(state.rateLimitSeconds).toBe(5)
  })

  test("rateLimitWait=true lands in state.rateLimitWait", async () => {
    await runServer(baseOptions({ rateLimitWait: true }))
    expect(state.rateLimitWait).toBe(true)
  })

  test("showToken=true lands in state.showToken", async () => {
    await runServer(baseOptions({ showToken: true }))
    expect(state.showToken).toBe(true)
  })
})

describe("runServer — proxyEnv toggle", () => {
  test("proxyEnv=true calls initProxyFromEnv", async () => {
    await runServer(baseOptions({ proxyEnv: true }))
    expect(initProxyFromEnvMock).toHaveBeenCalledTimes(1)
  })

  test("proxyEnv=false skips initProxyFromEnv", async () => {
    await runServer(baseOptions({ proxyEnv: false }))
    expect(initProxyFromEnvMock).toHaveBeenCalledTimes(0)
  })
})

describe("runServer — GitHub token resolution", () => {
  test("explicit githubToken option overrides disk store", async () => {
    storedRecord = { accessToken: "from-disk" }
    await runServer(baseOptions({ githubToken: "from-flag" }))
    expect(state.githubToken).toBe("from-flag")
    // logUser must be called once we have a token.
    expect(logUserMock).toHaveBeenCalledTimes(1)
    expect(setupCopilotTokenMock).toHaveBeenCalledTimes(1)
  })

  test("no flag + disk record present → token loaded from disk", async () => {
    storedRecord = { accessToken: "from-disk" }
    await runServer(baseOptions({ githubToken: undefined }))
    expect(state.githubToken).toBe("from-disk")
    expect(logUserMock).toHaveBeenCalledTimes(1)
  })

  test("no flag + no disk record → unauthenticated boot, no logUser call", async () => {
    storedRecord = null
    await runServer(baseOptions({ githubToken: undefined }))
    expect(state.githubToken).toBeUndefined()
    expect(logUserMock).toHaveBeenCalledTimes(0)
    expect(setupCopilotTokenMock).toHaveBeenCalledTimes(0)
  })

  test("disk-loaded token that fails Copilot bootstrap is cleared", async () => {
    storedRecord = { accessToken: "stale" }
    const tmpLogUser = logUserMock.getMockImplementation()
    ;(
      logUserMock as unknown as Mock<() => Promise<void>>
    ).mockImplementationOnce(() => Promise.reject(new Error("401 from /user")))
    try {
      await runServer(baseOptions({ githubToken: undefined }))
    } finally {
      if (tmpLogUser) logUserMock.mockImplementation(tmpLogUser)
    }
    // bootstrapUpstream catches the error and clears the token so
    // requireGithubAuth treats the proxy as unauthenticated.
    expect(state.githubToken).toBeUndefined()
  })

  test("a fatal Copilot rejection at boot surfaces its reason (not a generic sign-out)", async () => {
    // Reproduce the lapsed-license / TOS case: GitHub token is fine, but
    // Copilot rejects it fatally. The cause + remediation URL must reach the
    // Settings "Sign in" screen instead of dead-ending as a bare
    // "Not signed in".
    storedRecord = { accessToken: "good-token" }
    // Isolate from sibling-test pollution of the shared temp registry so the
    // fatal cleanly surfaces as the error state (auto-recovery is disabled, so
    // there's no account-switch path to take regardless).
    await realStoreModule.writeDefaultRegistry(realStoreModule.emptyRegistry())
    const tmpSetup = setupCopilotTokenMock.getMockImplementation()
    ;(
      setupCopilotTokenMock as unknown as Mock<() => Promise<void>>
    ).mockImplementationOnce(() =>
      Promise.reject(
        new CopilotAuthFatalError(
          "Copilot access has been revoked for this account.",
          403,
          "https://github.com/settings/copilot",
        ),
      ),
    )
    try {
      await runServer(baseOptions({ githubToken: undefined }))
    } finally {
      if (tmpSetup) setupCopilotTokenMock.mockImplementation(tmpSetup)
    }

    const status = getAuthStatus()
    if (status.state !== "error") {
      throw new Error(`expected error state, got ${status.state}`)
    }
    expect(status.error).toContain("revoked")
    expect(status.remediation_url).toBe("https://github.com/settings/copilot")
    // Token is cleared (signed out) but the reason is preserved.
    expect(state.githubToken).toBeUndefined()

    // Reset controller state so the error doesn't bleed into sibling tests.
    await signOut()
  })
})

describe("runServer — boot logger format", () => {
  test("first log line includes pid, version, branch, port, account", async () => {
    const port = pickFreePort()
    await runServer(baseOptions({ port, accountType: "business" }))
    const first = bootLogMessages[0]
    expect(first).toBeDefined()
    expect(first).toContain("maximal start")
    expect(first).toContain(`pid=${process.pid}`)
    expect(first).toContain("version=")
    expect(first).toContain("branch=")
    expect(first).toContain(`port=${port}`)
    expect(first).toContain("account=business")
  })

  test("second log line reports listening url + executor + auth state (unauth)", async () => {
    storedRecord = null
    const port = pickFreePort()
    await runServer(baseOptions({ port, githubToken: undefined }))
    const listening = bootLogMessages.find((m) => m.startsWith("listening "))
    expect(listening).toBeDefined()
    expect(listening).toContain(`url=http://localhost:${port}`)
    expect(listening).toContain("executor=")
    expect(listening).toContain("auth=unauthenticated")
  })

  test("listening log reports auth=authenticated when token is loaded", async () => {
    storedRecord = { accessToken: "good-token" }
    await runServer(baseOptions({ githubToken: undefined }))
    const listening = bootLogMessages.find((m) => m.startsWith("listening "))
    expect(listening).toContain("auth=authenticated")
  })
})

describe("runServer — server bind", () => {
  test("calls srvx.serve with the configured port", async () => {
    const port = pickFreePort()
    await runServer(baseOptions({ port }))
    expect(serveMock).toHaveBeenCalledTimes(1)
    const [arg] = serveMock.mock.calls[0] as unknown as [
      { port: number; bun: { idleTimeout: number } },
    ]
    expect(arg.port).toBe(port)
    expect(arg.bun.idleTimeout).toBe(0)
  })
})

describe("start.run — citty args → runServer options", () => {
  test("threads every flag into runServer (manifests as state mutation)", async () => {
    const port = pickFreePort()
    if (!start.run) throw new Error("start.run not defined")
    await (start.run as (ctx: unknown) => Promise<void>)({
      args: {
        port: String(port),
        verbose: true,
        "account-type": "enterprise",
        manual: true,
        "rate-limit": "7",
        wait: true,
        "github-token": "token-from-cli",
        "claude-code": false,
        "show-token": true,
        "proxy-env": true,
      },
    })

    expect(state.accountType).toBe("enterprise")
    expect(state.verbose).toBe(true)
    expect(state.manualApprove).toBe(true)
    expect(state.rateLimitSeconds).toBe(7)
    expect(state.rateLimitWait).toBe(true)
    expect(state.showToken).toBe(true)
    expect(state.githubToken).toBe("token-from-cli")
    expect(initProxyFromEnvMock).toHaveBeenCalled()
    // port gets parsed as number and forwarded to serve().
    const [arg] = serveMock.mock.calls.at(-1) as unknown as [{ port: number }]
    expect(arg.port).toBe(port)
  })

  test("rate-limit undefined → state.rateLimitSeconds undefined (not NaN)", async () => {
    if (!start.run) throw new Error("start.run not defined")
    await (start.run as (ctx: unknown) => Promise<void>)({
      args: {
        port: String(pickFreePort()),
        verbose: false,
        "account-type": "individual",
        manual: false,
        "rate-limit": undefined,
        wait: false,
        "github-token": undefined,
        "claude-code": false,
        "show-token": false,
        "proxy-env": false,
      },
    })
    expect(state.rateLimitSeconds).toBeUndefined()
  })

  test("port string is Number.parseInt'd (decimal), not coerced loosely", async () => {
    if (!start.run) throw new Error("start.run not defined")
    await (start.run as (ctx: unknown) => Promise<void>)({
      args: {
        port: "4242",
        verbose: false,
        "account-type": "individual",
        manual: false,
        "rate-limit": undefined,
        wait: false,
        "github-token": undefined,
        "claude-code": false,
        "show-token": false,
        "proxy-env": false,
      },
    })
    const [arg] = serveMock.mock.calls.at(-1) as unknown as [{ port: number }]
    expect(arg.port).toBe(4242)
    expect(typeof arg.port).toBe("number")
  })
})

// Re-install the real implementations of every overridden export so
// other test files in the same `bun test` process don't observe our
// stubs. Bun's `mock.restore()` only undoes function spies, not module
// mocks, so we re-`mock.module` each one back to the captured real
// module reference.
afterAll(async () => {
  globalThis.fetch = realFetch
  mock.restore()
  await mock.module("~/lib/platform/paths", () => realPathsModule)
  await mock.module("~/lib/http/proxy", () => realProxyModule)
  await mock.module("~/lib/auth/secrets", () => realSecretsModule)
  await mock.module("~/lib/platform/utils", () => realUtilsModule)
  await mock.module("~/lib/auth/token", () => realTokenModule)
  await mock.module("~/lib/auth/github-token-store", () => realStoreModule)
  await mock.module("~/lib/platform/logger", () => realLoggerModule)
  await mock.module("~/lib/platform/opencode", () => realOpencodeModule)
  await mock.module("srvx", () => realSrvxModule)
})
