/* eslint-disable max-lines, max-lines-per-function -- deterministic lifecycle scenario matrix. */
import {
  createPluginGenerationSelectionToken,
  preparePluginGeneration,
  type PreparedPluginGeneration,
  type ResolvedPlugin,
} from "@stuffbucket/maximal-plugin-loader"
import { afterEach, describe, expect, test } from "bun:test"
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"

import type {
  GenerationSelection,
  ParentToRunnerMessage,
  PreparedRunnerSnapshot,
  RunnerChannel,
  RunnerContainmentHooks,
  RunnerProcess,
  RunnerProcessExit,
  RunnerScheduler,
  RunnerSpawnCommand,
  RunnerToParentMessage,
  VerifiedRunnerGeneration,
} from "~/lib/plugins/runner/contracts"

import {
  pluginGenerationLifecycle,
  RELEASE_UPSTREAM_SESSION_METHOD,
} from "~/lib/plugins/generation-lifecycle"
import { currentPluginGenerationBuild } from "~/lib/plugins/generations"
import {
  INTERNAL_PLUGIN_RUNNER_COMMAND,
  RUNNER_SELECTION_ENV,
  resolveRunnerCommand,
} from "~/lib/plugins/runner/command"
import {
  RUNNER_API_VERSION,
  RUNNER_PROTOCOL_VERSION,
} from "~/lib/plugins/runner/contracts"
import {
  ImmutableGenerationVerifier,
  VerifiedGenerationInventoryComposer,
} from "~/lib/plugins/runner/entry"
import {
  PluginRunnerIndeterminateError,
  PluginRunnerShutdownError,
  PluginRunnerUnavailableError,
} from "~/lib/plugins/runner/errors"
import { processRunnerChannelFactory } from "~/lib/plugins/runner/process"
import {
  productionRunnerEnvironment,
  startProductionPluginRunner,
} from "~/lib/plugins/runner/production"
import { runPluginRunner } from "~/lib/plugins/runner/runner"
import { decodeGenerationSelection } from "~/lib/plugins/runner/selection"
import {
  IllegalRunnerStateTransitionError,
  RunnerStateMachine,
} from "~/lib/plugins/runner/state-machine"
import {
  PluginRunnerSupervisor,
  validatePreparedRunnerSnapshot,
} from "~/lib/plugins/runner/supervisor"

const digest = (character: string): string => character.repeat(64)
const selection: GenerationSelection = Object.freeze({
  token: Object.freeze({
    $schema: "maximal-plugin-generation-selection/1",
    reverify: "runner-hash-and-module-metadata-reverify-before-import/1",
    directory: "/generation",
    generationId: digest("1"),
    manifestSha256: digest("2"),
    artifacts: Object.freeze([
      Object.freeze({
        artifact: "modules/0/plugin.js",
        sha256: digest("3"),
        bytes: 42,
      }),
    ]),
    seal: digest("4"),
  }),
  controlEpoch: 7,
  inventoryDigest: digest("5"),
})

function prepared(
  overrides: Partial<PreparedRunnerSnapshot> = {},
): PreparedRunnerSnapshot {
  return {
    complete: true,
    revision: 3,
    controlEpoch: 7,
    generationId: selection.token.generationId,
    manifestSha256: selection.token.manifestSha256,
    inventoryDigest: selection.inventoryDigest,
    health: [{ pluginId: "workiq", classification: "healthy" }],
    snapshot: { plugins: [] },
    ...overrides,
  }
}

class FakeScheduler implements RunnerScheduler {
  #now = 0
  #nextId = 0
  readonly #tasks = new Map<number, { at: number; callback: () => void }>()

  now(): number {
    return this.#now
  }

  setTimeout(callback: () => void, delayMs: number): () => void {
    const id = ++this.#nextId
    this.#tasks.set(id, { at: this.#now + delayMs, callback })
    return () => this.#tasks.delete(id)
  }

  advance(ms: number): void {
    const target = this.#now + ms
    while (true) {
      const next = [...this.#tasks]
        .filter(([, task]) => task.at <= target)
        .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])
        .at(0)
      if (!next) break
      this.#tasks.delete(next[0])
      this.#now = next[1].at
      next[1].callback()
    }
    this.#now = target
  }
}

class FakeProcess implements RunnerProcess {
  readonly pid: number
  readonly parentMessages: Array<ParentToRunnerMessage> = []
  readonly kills: Array<string> = []
  exitOnKill = true
  readonly #messages = new Set<(message: unknown) => void>()
  readonly #closes = new Set<() => void>()
  readonly #exit = Promise.withResolvers<RunnerProcessExit>()
  #exited = false

  constructor(pid: number) {
    this.pid = pid
  }

  sendIpc(message: unknown): void {
    this.parentMessages.push(message as ParentToRunnerMessage)
  }

  subscribeIpc(listener: (message: unknown) => void): () => void {
    this.#messages.add(listener)
    return () => this.#messages.delete(listener)
  }

  onIpcClose(listener: () => void): () => void {
    this.#closes.add(listener)
    return () => this.#closes.delete(listener)
  }

  kill(signal = "SIGTERM"): void {
    this.kills.push(signal)
    if (this.exitOnKill) this.exit({ code: null, signal })
  }

  wait(): Promise<RunnerProcessExit> {
    return this.#exit.promise
  }

  emit(message: unknown): void {
    for (const listener of this.#messages) listener(message)
  }

  disconnect(): void {
    for (const listener of this.#closes) listener()
  }

  exit(exit: RunnerProcessExit): void {
    if (this.#exited) return
    this.#exited = true
    for (const listener of this.#closes) listener()
    this.#exit.resolve(exit)
  }
}

class FakeSpawner {
  readonly processes: Array<FakeProcess> = []
  readonly commands: Array<RunnerSpawnCommand> = []

  spawn(command: RunnerSpawnCommand): Promise<RunnerProcess> {
    this.commands.push(command)
    const child = new FakeProcess(10_000 + this.processes.length)
    this.processes.push(child)
    return Promise.resolve(child)
  }
}

class DeferredSpawner extends FakeSpawner {
  readonly pending = Promise.withResolvers<RunnerProcess>()

  override spawn(command: RunnerSpawnCommand): Promise<RunnerProcess> {
    this.commands.push(command)
    return this.pending.promise
  }

  resolve(): FakeProcess {
    const child = new FakeProcess(20_000 + this.processes.length)
    this.processes.push(child)
    this.pending.resolve(child)
    return child
  }
}

class FakeRunnerChannel implements RunnerChannel {
  readonly sent: Array<RunnerToParentMessage | ParentToRunnerMessage> = []
  readonly #messages = new Set<(message: unknown) => void>()
  readonly #closes = new Set<() => void>()

  send(message: RunnerToParentMessage | ParentToRunnerMessage): void {
    this.sent.push(message)
  }

  subscribe(listener: (message: unknown) => void): () => void {
    this.#messages.add(listener)
    return () => this.#messages.delete(listener)
  }

  onClose(listener: () => void): () => void {
    this.#closes.add(listener)
    return () => this.#closes.delete(listener)
  }

  close(): void {
    for (const listener of this.#closes) listener()
  }

  emit(message: ParentToRunnerMessage): void {
    for (const listener of this.#messages) listener(message)
  }
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve))
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error("Expected promise to reject.")
}

function noopContainment(): RunnerContainmentHooks {
  return {
    attach() {},
    terminateDescendants() {},
    reaped() {},
  }
}

function makeSupervisor(
  options: {
    scheduler?: FakeScheduler
    spawner?: FakeSpawner
    containment?: RunnerContainmentHooks
    config?: ConstructorParameters<typeof PluginRunnerSupervisor>[0]["config"]
  } = {},
) {
  const scheduler = options.scheduler ?? new FakeScheduler()
  const spawner = options.spawner ?? new FakeSpawner()
  const installed: Array<PreparedRunnerSnapshot> = []
  const supervisor = new PluginRunnerSupervisor({
    selection,
    command: {
      executable: "/usr/bin/bun",
      sourceEntry: "/repo/src/main.ts",
      cwd: "/repo",
      packaged: false,
      baseEnv: {},
    },
    spawner,
    channelFactory: processRunnerChannelFactory,
    stateAuthority: {
      currentControlEpoch: () => 7,
      validatePrepared() {},
      installInitial(snapshot) {
        installed.push(snapshot)
      },
    },
    scheduler,
    nonce: () => "nonce-1",
    containment: options.containment ?? noopContainment(),
    config: {
      startupTimeoutMs: 100,
      heartbeatTimeoutMs: 50,
      drainTimeoutMs: 80,
      shutdownBudgetMs: 100,
      reapReserveMs: 20,
      backoffBaseMs: 10,
      backoffMaxMs: 40,
      circuitFailures: 3,
      circuitWindowMs: 1_000,
      circuitResetMs: 100,
      ...options.config,
    },
  })
  return { supervisor, scheduler, spawner, installed }
}

function hello(overrides: Record<string, unknown> = {}): unknown {
  return {
    type: "runner.hello",
    nonce: "nonce-1",
    protocol: RUNNER_PROTOCOL_VERSION,
    pluginApi: RUNNER_API_VERSION,
    generationId: selection.token.generationId,
    manifestSha256: selection.token.manifestSha256,
    selectionSeal: selection.token.seal,
    ...overrides,
  }
}

async function bootActive(
  supervisor: PluginRunnerSupervisor,
  spawner: FakeSpawner,
): Promise<FakeProcess> {
  const started = supervisor.start()
  await flush()
  const child = spawner.processes.at(-1)
  if (!child) throw new Error("Runner process was not spawned.")
  child.emit(hello())
  child.emit({ type: "runner.state", state: "negotiated" })
  child.emit({ type: "runner.state", state: "preparing" })
  child.emit({ type: "runner.state", state: "prepared", prepared: prepared() })
  await flush()
  child.emit({ type: "runner.state", state: "committing" })
  child.emit({ type: "runner.state", state: "active" })
  await started
  return child
}

const roots = new Set<string>()

async function realGeneration(
  options: {
    runtimeName?: string
    metadataName?: string
  } = {},
): Promise<{
  generation: PreparedPluginGeneration
  selection: GenerationSelection
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "runner-generation-"))
  roots.add(root)
  const source = path.join(root, "source")
  await mkdir(source)
  const entrypoint = path.join(source, "selected.ts")
  const runtimeName = options.runtimeName ?? "selected"
  await writeFile(
    entrypoint,
    `const Config = { "~standard": { version: 1, vendor: "fixture", validate(value) { return { value } } } }\nexport const plugin = { name: ${JSON.stringify(runtimeName)}, manifest: { id: ${JSON.stringify(runtimeName)}, kind: "extension", displayName: "Selected", description: "Fixture plugin.", settingsVersion: 1 }, inject: [], provides: [], Config, apply() {} }\n`,
  )
  const plugin: ResolvedPlugin = {
    id: "selected",
    descriptorId: "selected-descriptor",
    provenance: "built-in",
    definedIn: "test",
    descriptor: {
      id: "selected-descriptor",
      provenance: "built-in",
      module: { moduleId: "selected-module", export: "plugin" },
    },
  }
  const generation = await preparePluginGeneration({
    artifactRoot: path.join(root, "artifacts"),
    inventory: { plugins: [plugin], sources: ["test"] },
    enabledPluginIds: ["selected"],
    hostServices: [],
    build: currentPluginGenerationBuild(),
    targets: [
      {
        moduleId: "selected-module",
        entrypoint,
        metadata: {
          name: options.metadataName ?? "selected",
          inject: [],
          provides: [],
        },
        trustedRoots: [source, process.cwd()],
      },
    ],
  })
  const token = await createPluginGenerationSelectionToken(generation)
  return {
    generation,
    selection: {
      token,
      controlEpoch: 7,
      inventoryDigest: generation.manifest.inventoryDigest,
    },
  }
}

afterEach(async () => {
  await Promise.all(
    [...roots].map((root) => rm(root, { recursive: true, force: true })),
  )
  roots.clear()
})

describe("runner command, generation, and child lifecycle", () => {
  test("classifies source, built-JS, and compiled runner environments", () => {
    const source = productionRunnerEnvironment({
      executable: "/opt/bun/bin/bun",
      argumentEntry: "/repo/src/main.ts",
      cwd: "/repo",
      fallbackSourceEntry: "/repo/src/main.ts",
    })
    expect(source).toMatchObject({
      executable: "/opt/bun/bin/bun",
      sourceEntry: "/repo/src/main.ts",
      packaged: false,
    })

    const built = productionRunnerEnvironment({
      executable: String.raw`C:\tools\bun.exe`,
      argumentEntry: "/repo/dist/main.js",
      cwd: "/repo",
      fallbackSourceEntry: "/repo/src/main.ts",
    })
    expect(built).toMatchObject({
      sourceEntry: "/repo/dist/main.js",
      packaged: false,
    })

    const compiled = productionRunnerEnvironment({
      executable: "/Applications/Maximal/maximal",
      argumentEntry: "ignored",
      cwd: "/app",
      fallbackSourceEntry: "/repo/src/main.ts",
    })
    expect(compiled).toMatchObject({
      executable: "/Applications/Maximal/maximal",
      packaged: true,
    })
  })

  test("resolves source-mode and packaged self-spawn commands", () => {
    const source = resolveRunnerCommand(
      {
        executable: "/usr/bin/bun",
        sourceEntry: "/repo/src/main.ts",
        cwd: "/repo",
        packaged: false,
      },
      "nonce",
      selection,
    )
    expect(source).toMatchObject({
      executable: "/usr/bin/bun",
      args: ["run", "/repo/src/main.ts", INTERNAL_PLUGIN_RUNNER_COMMAND],
      mode: "source",
    })
    expect(decodeGenerationSelection(source.env[RUNNER_SELECTION_ENV])).toEqual(
      selection,
    )
    const packaged = resolveRunnerCommand(
      {
        executable: "/Applications/Maximal/maximal",
        sourceEntry: "ignored",
        cwd: "/app",
        packaged: true,
      },
      "nonce",
      selection,
    )
    expect(packaged).toMatchObject({
      executable: "/Applications/Maximal/maximal",
      args: [INTERNAL_PLUGIN_RUNNER_COMMAND],
      mode: "packaged",
    })
  })

  test("starts a real source-mode child and serves its projected gateway", async () => {
    const fixture = await realGeneration()
    const home = await mkdtemp(path.join(os.tmpdir(), "runner-child-home-"))
    roots.add(home)
    const baseEnv = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    )
    const gateway = await startProductionPluginRunner({
      select: () => Promise.resolve(fixture.selection.token),
      storageRoot: path.join(home, "parent-plugins"),
      command: {
        executable: process.execPath,
        sourceEntry: path.resolve(import.meta.dir, "../src/main.ts"),
        cwd: process.cwd(),
        packaged: false,
        baseEnv: {
          ...baseEnv,
          COPILOT_API_HOME: path.join(home, "child-app"),
        },
      },
    })
    expect(gateway?.list()).toMatchObject([
      { id: "selected", lifecycle: "disabled" },
    ])
    await gateway?.dispose()
  }, 20_000)

  test("rejects illegal state transitions", () => {
    const machine = new RunnerStateMachine()
    expect(() => machine.transition("active")).toThrow(
      IllegalRunnerStateTransitionError,
    )
    for (const state of [
      "negotiated",
      "preparing",
      "prepared",
      "committing",
      "active",
      "draining",
      "stopping",
      "stopped",
    ] as const)
      machine.transition(state)
  })

  test("validates every prepared snapshot fence and health class", () => {
    for (const [snapshot, message] of [
      [prepared({ complete: false }), "incomplete"],
      [prepared({ revision: -1 }), "revision"],
      [prepared({ controlEpoch: 6 }), "epoch"],
      [prepared({ generationId: digest("a") }), "generation"],
      [prepared({ manifestSha256: digest("b") }), "artifact"],
      [prepared({ inventoryDigest: digest("c") }), "inventory"],
      [
        prepared({
          health: [{ pluginId: "x", classification: "waiting-dependency" }],
        }),
        "waiting-dependency",
      ],
      [
        prepared({ health: [{ pluginId: "x", classification: "regression" }] }),
        "regression",
      ],
      [
        prepared({
          health: [{ pluginId: "x", classification: "host-failure" }],
        }),
        "host-failure",
      ],
    ] as const)
      expect(() =>
        validatePreparedRunnerSnapshot(snapshot, selection, 7),
      ).toThrow(message)
    for (const classification of [
      "healthy",
      "needs-setup",
      "signed-out",
      "existing-failure",
    ] as const)
      expect(() =>
        validatePreparedRunnerSnapshot(
          prepared({ health: [{ pluginId: "x", classification }] }),
          selection,
          7,
        ),
      ).not.toThrow()
  })

  test("reverifies bytes and passes the canonical imported module object", async () => {
    const fixture = await realGeneration()
    const verifier = new ImmutableGenerationVerifier()
    const verified = await verifier.reverifyImmediatelyBeforeLoad(
      fixture.selection,
      new AbortController().signal,
    )
    const descriptor = fixture.generation.manifest.modules[0]
    const artifact = path.join(
      fixture.generation.directory,
      descriptor.artifact,
    )
    const namespace: unknown = await import(
      `${pathToFileURL(artifact).href}?generation=${fixture.generation.manifest.generationId}`
    )
    if (namespace === null || typeof namespace !== "object")
      throw new Error("Fixture did not import as a module namespace.")
    expect(verified.modules[0]).toBe(Reflect.get(namespace, "plugin"))

    const root = await new VerifiedGenerationInventoryComposer().compose(
      verified,
      fixture.selection,
      new AbortController().signal,
    )
    expect((await root.prepare()).snapshot).toMatchObject({
      plugins: [{ id: "selected" }],
    })
    expect(
      await root.dispatch?.(RELEASE_UPSTREAM_SESSION_METHOD, {
        sessionId: "session-a",
      }),
    ).toBeNull()
    await root.dispose()
  })

  test("rejects artifact-byte mutation and runtime metadata tampering", async () => {
    const mutated = await realGeneration()
    const descriptor = mutated.generation.manifest.modules[0]
    const artifact = path.join(
      mutated.generation.directory,
      descriptor.artifact,
    )
    if (process.platform !== "win32") await chmod(artifact, 0o600)
    await writeFile(
      artifact,
      `${await readFile(artifact, "utf8")}\n// tampered\n`,
    )
    expect(
      await rejectionOf(
        new ImmutableGenerationVerifier().reverifyImmediatelyBeforeLoad(
          mutated.selection,
          new AbortController().signal,
        ),
      ),
    ).toMatchObject({ code: "hash-mismatch" })

    const metadata = await realGeneration({ runtimeName: "other" })
    expect(
      await rejectionOf(
        new ImmutableGenerationVerifier().reverifyImmediatelyBeforeLoad(
          metadata.selection,
          new AbortController().signal,
        ),
      ),
    ).toMatchObject({ code: "module-metadata-mismatch" })
  })

  test("hard-exits independently of blocked prepare and dispatch work", async () => {
    for (const phase of ["prepare", "dispatch"] as const) {
      const fixture = await realGeneration()
      const verified =
        await new ImmutableGenerationVerifier().reverifyImmediatelyBeforeLoad(
          fixture.selection,
          new AbortController().signal,
        )
      const channel = new FakeRunnerChannel()
      const blockedPrepare = Promise.withResolvers<PreparedRunnerSnapshot>()
      const blockedDispatch = Promise.withResolvers<null>()
      let signal: AbortSignal | undefined
      let hardExit = 0
      const run = runPluginRunner({
        nonce: "nonce",
        selection: fixture.selection,
        channel,
        parentDeathDeadlineMs: 5,
        hardExit: () => {
          hardExit += 1
        },
        verifier: {
          reverifyImmediatelyBeforeLoad: () => Promise.resolve(verified),
        },
        composer: {
          compose(_generation, selected, receivedSignal) {
            signal = receivedSignal
            return Promise.resolve({
              prepare: () =>
                phase === "prepare" ?
                  blockedPrepare.promise
                : Promise.resolve({
                    complete: true,
                    revision: 0,
                    controlEpoch: selected.controlEpoch,
                    generationId: selected.token.generationId,
                    manifestSha256: selected.token.manifestSha256,
                    inventoryDigest: selected.inventoryDigest,
                    health: [],
                    snapshot: {},
                  }),
              activate: () => Promise.resolve(),
              dispatch: () => blockedDispatch.promise,
              drain: () => Promise.resolve(),
              dispose: () => Promise.resolve(),
            })
          },
        },
      })
      channel.emit({
        type: "supervisor.accept",
        nonce: "nonce",
        protocol: RUNNER_PROTOCOL_VERSION,
        pluginApi: RUNNER_API_VERSION,
      })
      await flush()
      if (phase === "dispatch") {
        channel.emit({ type: "supervisor.activate" })
        await flush()
        channel.emit({
          type: "supervisor.dispatch",
          callId: "blocked",
          method: "tool",
          params: {},
        })
        await flush()
      }
      channel.close()
      expect(signal?.aborted).toBeTrue()
      await Bun.sleep(10)
      expect(hardExit).toBe(1)
      if (phase === "prepare")
        blockedPrepare.resolve({
          complete: true,
          revision: 0,
          controlEpoch: fixture.selection.controlEpoch,
          generationId: fixture.selection.token.generationId,
          manifestSha256: fixture.selection.token.manifestSha256,
          inventoryDigest: fixture.selection.inventoryDigest,
          health: [],
          snapshot: {},
        })
      else blockedDispatch.resolve(null)
      await run
    }
  })

  test("aborts parent-death work and enforces an independent hard-exit deadline", async () => {
    const channel = new FakeRunnerChannel()
    const blocked = Promise.withResolvers<VerifiedRunnerGeneration>()
    let signal: AbortSignal | undefined
    let hardExit = 0
    const run = runPluginRunner({
      nonce: "nonce",
      selection,
      channel,
      parentDeathDeadlineMs: 5,
      hardExit: () => {
        hardExit += 1
      },
      verifier: {
        reverifyImmediatelyBeforeLoad(_selection, receivedSignal) {
          signal = receivedSignal
          return blocked.promise
        },
      },
      composer: {
        compose: () => Promise.reject(new Error("must not compose")),
      },
    })
    channel.emit({
      type: "supervisor.accept",
      nonce: "nonce",
      protocol: RUNNER_PROTOCOL_VERSION,
      pluginApi: RUNNER_API_VERSION,
    })
    await flush()
    channel.close()
    expect(signal?.aborted).toBeTrue()
    await Bun.sleep(10)
    expect(hardExit).toBe(1)
    blocked.reject(new Error("aborted"))
    await run
  })
})

describe("PluginRunnerSupervisor", () => {
  test("routes production MCP upstream release through the owning runner", async () => {
    const { supervisor, spawner } = makeSupervisor()
    const child = await bootActive(supervisor, spawner)
    const release = pluginGenerationLifecycle.releaseUpstreamSession(
      selection.token.generationId,
      "session-a",
      new AbortController().signal,
    )
    await flush()
    const dispatch = child.parentMessages.find(
      (message) => message.type === "supervisor.dispatch",
    )
    expect(dispatch).toMatchObject({
      type: "supervisor.dispatch",
      method: "mcp.release-upstream-session",
      params: { sessionId: "session-a" },
    })
    if (!dispatch) throw new Error("Release dispatch was not sent.")
    child.emit({
      type: "runner.result",
      callId: dispatch.callId,
      value: null,
    })
    await release
  })

  test("makes concurrent start and restart races single-flight", async () => {
    const first = makeSupervisor()
    const starts = [
      first.supervisor.start(),
      first.supervisor.start(),
      first.supervisor.start(),
    ]
    await flush()
    expect(first.spawner.processes).toHaveLength(1)
    const child = first.spawner.processes[0]
    child.exit({ code: 1, signal: null })
    await Promise.all(starts.map((start) => rejectionOf(start)))
    await flush()
    first.scheduler.advance(10)
    const manual = first.supervisor.start()
    await flush()
    expect(first.spawner.processes).toHaveLength(2)
    first.spawner.processes[1].exit({ code: 1, signal: null })
    await rejectionOf(manual)
  })

  test("cancels a pending spawn and kills, reaps, and never installs its late child", async () => {
    const spawner = new DeferredSpawner()
    const calls: Array<string> = []
    const fixture = makeSupervisor({
      spawner,
      containment: {
        attach() {
          calls.push("attach")
        },
        terminateDescendants() {
          calls.push("terminate")
        },
        reaped() {
          calls.push("reaped")
        },
      },
    })
    const start = fixture.supervisor.start()
    const shutdown = fixture.supervisor.shutdown("test")
    const child = spawner.resolve()
    await shutdown
    expect(await rejectionOf(start)).toMatchObject({ reason: "shutting-down" })
    expect(child.kills).toEqual(["SIGKILL"])
    expect(calls).toEqual(["attach", "terminate", "reaped"])
    const diagnostics = fixture.supervisor.diagnostics()
    expect(diagnostics.availability).toBe("stopped")
    expect("pid" in diagnostics).toBeFalse()
  })

  test("rejects lifecycle data before hello and duplicate or mismatched hello", async () => {
    for (const firstMessage of [
      { type: "runner.state", state: "negotiated" },
      hello({ nonce: "other" }),
    ]) {
      const { supervisor, spawner } = makeSupervisor()
      const start = supervisor.start()
      await flush()
      spawner.processes[0].emit(firstMessage)
      expect(await rejectionOf(start)).toMatchObject({ reason: "protocol" })
      expect(spawner.processes[0].kills).toContain("SIGKILL")
    }

    const { supervisor, spawner } = makeSupervisor()
    const start = supervisor.start()
    await flush()
    spawner.processes[0].emit(hello())
    spawner.processes[0].emit(hello())
    expect(await rejectionOf(start)).toMatchObject({ reason: "protocol" })
  })

  test("validates exact protocol, API, generation, manifest, and seal identities", async () => {
    for (const override of [
      { protocol: "other" },
      { pluginApi: "other" },
      { generationId: digest("a") },
      { manifestSha256: digest("b") },
      { selectionSeal: digest("c") },
    ]) {
      const { supervisor, spawner } = makeSupervisor()
      const start = supervisor.start()
      await flush()
      spawner.processes[0].emit(hello(override))
      expect(await rejectionOf(start)).toBeInstanceOf(
        PluginRunnerUnavailableError,
      )
    }
  })

  test("enforces startup and heartbeat deadlines", async () => {
    const first = makeSupervisor()
    const startup = first.supervisor.start()
    await flush()
    first.scheduler.advance(100)
    expect(await rejectionOf(startup)).toMatchObject({
      reason: "startup-timeout",
    })

    const second = makeSupervisor()
    const child = await bootActive(second.supervisor, second.spawner)
    second.scheduler.advance(50)
    await flush()
    expect(child.kills).toContain("SIGKILL")
    expect(second.supervisor.diagnostics().lastCrash?.reason).toBe(
      "heartbeat-lost",
    )
  })

  test("classifies crashes before and after dispatch without replay", async () => {
    const before = makeSupervisor()
    let child = await bootActive(before.supervisor, before.spawner)
    const queued = before.supervisor.beginInvocation("tool", {})
    child.exit({ code: 9, signal: null })
    expect(await rejectionOf(queued.result)).toBeInstanceOf(
      PluginRunnerUnavailableError,
    )

    const after = makeSupervisor()
    child = await bootActive(after.supervisor, after.spawner)
    const dispatched = after.supervisor.beginInvocation("tool", {})
    dispatched.dispatch()
    child.exit({ code: 9, signal: null })
    expect(await rejectionOf(dispatched.result)).toBeInstanceOf(
      PluginRunnerIndeterminateError,
    )
    expect(after.supervisor.diagnostics().lastCrash?.indeterminateCalls).toBe(1)
  })

  test("uses bounded exponential backoff and opens a circuit", async () => {
    const { supervisor, scheduler, spawner } = makeSupervisor()
    const initial = supervisor.start()
    await flush()
    spawner.processes[0].exit({ code: 1, signal: null })
    await rejectionOf(initial)
    await flush()
    expect(supervisor.diagnostics().backoffUntil).toBe(10)
    scheduler.advance(10)
    await flush()
    spawner.processes[1].exit({ code: 1, signal: null })
    await flush()
    expect(supervisor.diagnostics().backoffUntil).toBe(30)
    scheduler.advance(20)
    await flush()
    spawner.processes[2].exit({ code: 1, signal: null })
    await flush()
    expect(supervisor.diagnostics()).toMatchObject({
      availability: "circuit-open",
      circuitOpenUntil: 130,
    })
  })

  test("fails closed and kills a child when containment attachment fails", async () => {
    const calls: Array<string> = []
    const { supervisor, spawner } = makeSupervisor({
      containment: {
        attach() {
          calls.push("attach")
          throw new Error("containment unavailable")
        },
        terminateDescendants() {
          calls.push("terminate")
        },
        reaped() {
          calls.push("reaped")
        },
      },
    })
    expect(await rejectionOf(supervisor.start())).toBeInstanceOf(
      PluginRunnerUnavailableError,
    )
    expect(spawner.processes[0].kills).toEqual(["SIGKILL"])
    expect(calls).toEqual(["attach", "terminate", "reaped"])
  })

  test("reports stopped only after direct child, tree, and containment reap", async () => {
    const reaped = Promise.withResolvers<undefined>()
    const { supervisor, spawner } = makeSupervisor({
      containment: {
        attach() {},
        terminateDescendants() {},
        reaped: () => reaped.promise,
      },
    })
    const child = await bootActive(supervisor, spawner)
    const shutdown = supervisor.shutdown("test")
    child.emit({ type: "runner.state", state: "draining" })
    child.emit({ type: "runner.drained" })
    await flush()
    child.emit({ type: "runner.state", state: "stopping" })
    child.emit({ type: "runner.state", state: "stopped" })
    child.exit({ code: 0, signal: null })
    await flush()
    expect(supervisor.diagnostics().availability).toBe("shutting-down")
    reaped.resolve(undefined)
    await shutdown
    expect(supervisor.diagnostics().availability).toBe("stopped")
  })

  test("sends direct SIGKILL before a hanging tree hook and rejects at budget", async () => {
    const tree = Promise.withResolvers<undefined>()
    const { supervisor, scheduler, spawner } = makeSupervisor({
      containment: {
        attach() {},
        terminateDescendants: () => tree.promise,
        reaped() {},
      },
    })
    const child = await bootActive(supervisor, spawner)
    child.exitOnKill = false
    const shutdown = supervisor.shutdown("test", 100)
    scheduler.advance(80)
    expect(child.kills).toContain("SIGKILL")
    scheduler.advance(20)
    expect(await rejectionOf(shutdown)).toBeInstanceOf(
      PluginRunnerShutdownError,
    )
    expect(supervisor.diagnostics().availability).toBe("shutting-down")
    tree.resolve(undefined)
    child.exit({ code: null, signal: "SIGKILL" })
    await flush()
    expect(supervisor.diagnostics().availability).toBe("stopped")
  })

  test("rejects shutdown budget while an unresolved spawn remains cancellable", async () => {
    const spawner = new DeferredSpawner()
    const { supervisor, scheduler } = makeSupervisor({ spawner })
    const start = supervisor.start()
    const shutdown = supervisor.shutdown("test", 100)
    scheduler.advance(100)
    expect(await rejectionOf(shutdown)).toBeInstanceOf(
      PluginRunnerShutdownError,
    )
    expect(supervisor.diagnostics().availability).toBe("shutting-down")
    const child = spawner.resolve()
    expect(await rejectionOf(start)).toMatchObject({ reason: "shutting-down" })
    expect(child.kills).toContain("SIGKILL")
  })
})
