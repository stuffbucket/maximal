/**
 * Windows containment, end to end: the real broker (the compiled one when
 * MAXIMAL_MCP_BROKER_BINARY is set) starts an MCP server through a `.cmd`
 * file in a folder with a space in its name, the way an npm-installed
 * command is started. That server starts a child of its own. However the
 * broker ends (terminated, its parent gone, or a clean shutdown), the server,
 * the cmd.exe running it, and the server's child must all be gone within a
 * few seconds. On POSIX the supervisor's process-group kill does this
 * instead, so these run only on Windows.
 */
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client"
import { afterEach, describe, expect, it } from "bun:test"
import {
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
  spawn,
} from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import {
  CONTROL_PROTOCOL,
  CONTROL_PROTOCOL_VERSION,
  ControlFrameDecoder,
  type ControlEnvelope,
  encodeControlEnvelope,
} from "../src/control-protocol.ts"
import { BrokerWireConfigurationSchema } from "../src/wire-config.ts"

const GENERATION = "containment-test-generation"
const API_KEY = "containment-test-key-that-is-longer-than-32-bytes"
/** How long Windows gets to end everything once the broker is gone. */
const GONE_WITHIN_MS = 5_000

const isRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const waitFor = async (
  condition: () => boolean,
  timeoutMs: number,
  what: string,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (condition()) return
    await Bun.sleep(100)
  }
  throw new Error(`timed out waiting for ${what}`)
}

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

/** Kill leftovers if a test failed, so the runner isn't left with them. */
const reap = (pids: Iterable<number>) => {
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL")
    } catch {
      // Already gone, which is the point.
    }
  }
}

/** A folder with a space in its name holding the server's `.cmd` file. */
const serverFixture = () => {
  const dir = mkdtempSync(join(tmpdir(), "maximal containment "))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const pidFile = join(dir, "pids.txt")
  writeFileSync(pidFile, "")
  const command = join(dir, "containment server.cmd")
  writeFileSync(
    command,
    `@echo off\r\n"${process.execPath}" "${resolve(import.meta.dir, "containment-server.ts")}" %*\r\n`,
  )
  /** Every process the server instances reported: cmd.exe, the server,
   *  and its child, per instance. */
  const pids = (): Array<number> =>
    readFileSync(pidFile, "utf8")
      .split(/\r?\n/u)
      .filter(Boolean)
      .flatMap((line) => line.split(" ").map(Number))
      .filter((pid) => Number.isSafeInteger(pid) && pid > 0)
  const instances = (): number =>
    readFileSync(pidFile, "utf8").split(/\r?\n/u).filter(Boolean).length
  return { command, pidFile, pids, instances }
}

interface BrokerOptions {
  parentPid?: number
  /** Start it through containment-launcher.ts, which owns its stdin and can
   *  first put itself in a job of the given kind. */
  launcher?: "none" | "plain" | "ui-limited"
}

class Broker {
  /** The broker, or the launcher standing in for its parent. */
  readonly child: ChildProcessWithoutNullStreams
  readonly #pidFile: string | undefined
  readonly #decoder = new ControlFrameDecoder()
  readonly #envelopes: Array<ControlEnvelope> = []
  #sequence = 0
  stderr = ""

  constructor({ parentPid, launcher }: BrokerOptions = {}) {
    const compiled = process.env.MAXIMAL_MCP_BROKER_BINARY
    const args = [
      "serve",
      "--generation",
      GENERATION,
      ...(parentPid === undefined ? [] : ["--parent-pid", String(parentPid)]),
    ]
    const command = compiled ?? process.execPath
    const commandArgs =
      compiled ? args : [resolve(import.meta.dir, "../src/main.ts"), ...args]
    if (launcher) {
      const dir = mkdtempSync(join(tmpdir(), "maximal-launcher-"))
      cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
      this.#pidFile = join(dir, "broker.pid")
      this.child = spawn(
        process.execPath,
        [
          resolve(import.meta.dir, "containment-launcher.ts"),
          "--job",
          launcher,
          "--pid-file",
          this.#pidFile,
          "--",
          command,
          ...commandArgs,
        ],
        // Detached, so it is in no job of this test runner's.
        { detached: true, stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
      )
    } else {
      // As the supervisor starts it.
      this.child = spawn(command, commandArgs, {
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      })
    }
    this.child.stdout.on("data", (chunk: Buffer) => {
      this.#envelopes.push(...this.#decoder.push(chunk))
    })
    this.child.stderr.setEncoding("utf8")
    this.child.stderr.on("data", (chunk: string) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-8192)
    })
    const { child } = this
    cleanups.push(() => {
      if (child.exitCode === null) child.kill()
      const pid = this.brokerPid()
      if (pid !== undefined) reap([pid])
    })
  }

  /** The broker's own pid, when it was started through the launcher. */
  brokerPid(): number | undefined {
    if (!this.#pidFile) return undefined
    try {
      const pid = Number(readFileSync(this.#pidFile, "utf8"))
      return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined
    } catch {
      return undefined
    }
  }

  async take(
    operation: ControlEnvelope["operation"],
  ): Promise<ControlEnvelope> {
    let found: ControlEnvelope | undefined
    await waitFor(
      () => {
        const index = this.#envelopes.findIndex(
          (envelope) => envelope.operation === operation,
        )
        if (index !== -1) [found] = this.#envelopes.splice(index, 1)
        return found !== undefined || this.child.exitCode !== null
      },
      30_000,
      operation,
    )
    if (!found) {
      throw new Error(
        `broker exited (${this.child.exitCode}) before ${operation}: ${this.stderr}`,
      )
    }
    return found
  }

  send(
    operation: "configure" | "shutdown",
    payload: Record<string, unknown>,
  ): void {
    this.child.stdin.write(
      encodeControlEnvelope({
        protocol: CONTROL_PROTOCOL,
        version: CONTROL_PROTOCOL_VERSION,
        generation: GENERATION,
        sequence: this.#sequence,
        deadlineMs: Date.now() + 10_000,
        requestId: `${operation}-${this.#sequence}`,
        operation,
        payload,
      } as ControlEnvelope),
    )
    this.#sequence += 1
  }
}

/**
 * Start a broker serving the fixture server, open a session so an instance
 * is running, and return every process the server instances reported, all
 * checked alive. The probe's instance counts too: closing it ends cmd.exe,
 * but the server under it and that server's child keep running.
 */
const brokerWithRunningServer = async (options: BrokerOptions = {}) => {
  const server = serverFixture()
  const broker = new Broker(options)
  await broker.take("hello")
  broker.send("configure", {
    apiKey: API_KEY,
    configuration: BrokerWireConfigurationSchema.parse({
      endpoints: [
        {
          id: "fixture",
          label: "Fixture",
          command: server.command,
          args: ["--era", "legacy"],
          environment: { CONTAINMENT_PID_FILE: server.pidFile },
          protocol: "legacy",
          ownership: "exclusive",
        },
      ],
    }),
  })
  expect(await broker.take("response")).toMatchObject({
    payload: { ok: true },
  })
  const ready = await broker.take("ready")
  if (ready.operation !== "ready") throw new Error("expected ready")

  const client = new Client(
    { name: "containment-client", version: "0.0.0" },
    { versionNegotiation: { mode: "legacy" } },
  )
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${ready.payload.port}/mcp/fixture`),
    { requestInit: { headers: { Authorization: `Bearer ${API_KEY}` } } },
  )
  await client.connect(transport, { timeout: 30_000 })
  expect(
    await client.callTool({ name: "ordinary", arguments: {} }),
  ).toMatchObject({ content: [{ type: "text", text: "ordinary-ok" }] })
  // The probe's instance and this session's.
  await waitFor(() => server.instances() >= 2, 10_000, "two server instances")

  const pids = server.pids()
  cleanups.push(() => reap(server.pids()))
  // The session's instance: cmd.exe, the server, and its child.
  const session = pids.slice(-3)
  expect(session.every((pid) => isRunning(pid))).toBe(true)
  return { broker, client, transport, pids: () => server.pids() }
}

const expectAllGone = async (pids: Array<number>): Promise<void> => {
  try {
    await waitFor(
      () => pids.every((pid) => !isRunning(pid)),
      GONE_WITHIN_MS,
      "every server process to end",
    )
  } catch {
    const left = pids.filter((pid) => isRunning(pid))
    throw new Error(`still running after ${GONE_WITHIN_MS}ms: ${left.join(", ")}`)
  }
}

/** The broker's exit, or a failure that says what it wrote to stderr. */
const expectExit = async (broker: Broker, timeoutMs: number) => {
  try {
    const { child } = broker
    await waitFor(
      () => child.exitCode !== null || child.signalCode !== null,
      timeoutMs,
      "exit",
    )
  } catch {
    throw new Error(
      `the broker was still running after ${timeoutMs}ms; stderr:\n${broker.stderr}`,
    )
  }
  return broker.child.exitCode
}

const windows = process.platform === "win32"

describe.skipIf(!windows)("Windows containment", () => {
  it("ends every MCP server and its children when the broker is terminated", async () => {
    const { broker, pids } = await brokerWithRunningServer()
    // TerminateProcess, as the supervisor's last resort does.
    broker.child.kill()
    await expectExit(broker, GONE_WITHIN_MS)
    await expectAllGone(pids())
  }, 60_000)

  it("ends everything when the process that started the broker is gone", async () => {
    // Stands in for a sidecar that crashed.
    const parent: ChildProcess = spawn(
      process.execPath,
      [resolve(import.meta.dir, "containment-grandchild.ts")],
      { stdio: "ignore", windowsHide: true },
    )
    cleanups.push(() => {
      if (parent.exitCode === null) parent.kill()
    })
    await new Promise((resolveSpawn) => parent.once("spawn", resolveSpawn))
    const { broker, pids } = await brokerWithRunningServer({
      parentPid: parent.pid,
    })
    // The broker keeps running while its parent does.
    await Bun.sleep(2_000)
    expect(broker.child.exitCode).toBeNull()

    parent.kill()
    // A second to notice, then up to three for its servers to close.
    await expectExit(broker, 8_000)
    expect(broker.stderr).toContain("PARENT_EXITED")
    await expectAllGone(pids())
  }, 60_000)

  it("ends everything after a clean shutdown too", async () => {
    const { broker, client, transport, pids } = await brokerWithRunningServer()
    // End the session first, as an adapter does, so nothing holds the
    // broker's HTTP server open.
    await transport.terminateSession()
    await client.close()
    broker.send("shutdown", {})
    expect(await broker.take("response")).toMatchObject({
      payload: { ok: true },
    })
    expect(await expectExit(broker, 10_000)).toBe(0)
    await expectAllGone(pids())
  }, 60_000)

  it("ends everything when the process holding the broker's stdin is gone", async () => {
    // No --parent-pid: the broker learns from its stdin closing.
    const { broker, pids } = await brokerWithRunningServer({ launcher: "none" })
    const brokerPid = broker.brokerPid()
    expect(brokerPid).toBeNumber()
    broker.child.kill()
    // Up to three seconds for its servers to close, then it exits anyway.
    await waitFor(
      () => !isRunning(brokerPid as number),
      8_000,
      "the broker to exit after its stdin closed",
    )
    await expectAllGone(pids())
  }, 60_000)

  it("contains its servers when it starts inside another job", async () => {
    const { broker, pids } = await brokerWithRunningServer({
      launcher: "plain",
    })
    const brokerPid = broker.brokerPid()
    expect(brokerPid).toBeNumber()
    process.kill(brokerPid as number)
    await waitFor(
      () => !isRunning(brokerPid as number),
      GONE_WITHIN_MS,
      "the broker to end",
    )
    await expectAllGone(pids())
  }, 60_000)

  it("refuses to run, with status 78, when Windows won't give it a job", async () => {
    // A job with UI limits can't have jobs nested under it.
    const broker = new Broker({ launcher: "ui-limited" })
    expect(await expectExit(broker, 30_000)).toBe(78)
    expect(broker.stderr).toContain(
      "[maximal-mcp-broker] MCP_BROKER_CONTAINMENT_UNAVAILABLE step=assign",
    )
    // It started nothing, so it never said hello.
    expect(broker.stderr).not.toContain("[endpoint:")
  }, 60_000)
})
