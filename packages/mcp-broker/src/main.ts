import process from "node:process"

import {
  type RunningBrokerServer,
  BrokerStartupError,
  startBrokerServer,
} from "./broker-server.ts"
import {
  CONTROL_PROTOCOL,
  CONTROL_PROTOCOL_VERSION,
  ControlFrameDecoder,
  type ControlEnvelope,
  ControlProtocolError,
  ControlSequenceValidator,
  encodeControlEnvelope,
} from "./control-protocol.ts"
import { installSanitizedDependencyDiagnostics } from "./diagnostics.ts"
import { MaximalElicitations } from "./maximal-elicitations.ts"
import { runStdioAdapter } from "./stdio-adapter.ts"
import {
  CONTAINMENT_EXIT_CODE,
  ContainmentError,
  containInKillOnCloseJob,
  describeContainmentError,
} from "./windows-job.ts"

const BINARY_VERSION = "0.0.0"

const USAGE = `Usage:
  maximal-mcp-broker serve --generation <id> [--parent-pid <pid>]
      Run the MCP broker for Maximal, which starts it. Control frames on
      stdin and stdout; not for use by hand.
  maximal-mcp-broker stdio-adapter --url http://127.0.0.1:<port>/mcp/<id>
      Connect a stdio MCP client to one of Maximal's MCP endpoints. Set
      MAXIMAL_MCP_API_KEY when the endpoint needs a key.
  maximal-mcp-broker --version
  maximal-mcp-broker --help
`
const MESSAGE_DEADLINE_MS = 10_000
/** How long a broker told to stop by a signal, or whose parent is gone,
 *  waits for its servers to close before it exits anyway. */
const TERMINATE_GRACE_MS = 3_000

interface ServeOptions {
  generation: string
  parentPid?: number
}

const requiredValue = (
  args: Array<string>,
  index: number,
  flag: string,
): string => {
  const value = args[index + 1]
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`)
  }
  return value
}

const parseAdapterUrl = (args: Array<string>): string => {
  if (args.length !== 2 || args[0] !== "--url" || !args[1]) {
    throw new UsageError()
  }
  return args[1]
}

const parseServeOptions = (args: Array<string>): ServeOptions => {
  let generation: string | undefined
  let parentPid: number | undefined

  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]
    if (flag === "--generation") {
      generation = requiredValue(args, index, flag)
      index += 1
    } else if (flag === "--parent-pid") {
      parentPid = Number(requiredValue(args, index, flag))
      index += 1
    } else {
      throw new Error(`unknown serve option: ${flag}`)
    }
  }

  if (!generation) {
    throw new Error("--generation is required")
  }
  if (
    parentPid !== undefined
    && (!Number.isSafeInteger(parentPid) || parentPid < 1)
  ) {
    throw new Error("--parent-pid must be a positive integer")
  }

  return { generation, parentPid }
}

class ControlWriter {
  readonly #generation: string
  #sequence = 0
  #pending = Promise.resolve()

  constructor(generation: string) {
    this.#generation = generation
  }

  send(
    envelope: Omit<
      ControlEnvelope,
      "protocol" | "version" | "generation" | "sequence"
    >,
  ): Promise<void> {
    const completeEnvelope = {
      ...envelope,
      protocol: CONTROL_PROTOCOL,
      version: CONTROL_PROTOCOL_VERSION,
      generation: this.#generation,
      sequence: this.#sequence,
    } as ControlEnvelope
    this.#sequence += 1

    const frame = encodeControlEnvelope(completeEnvelope)
    this.#pending = this.#pending.then(
      () =>
        new Promise<void>((resolve, reject) => {
          const onError = (error: Error) => {
            process.stdout.off("error", onError)
            reject(error)
          }
          process.stdout.once("error", onError)
          const accepted = process.stdout.write(frame, () => {
            process.stdout.off("error", onError)
            resolve()
          })
          if (!accepted) {
            process.stdout.once("drain", () => undefined)
          }
        }),
    )
    return this.#pending
  }
}

/** An error whose message is already a code, like ADAPTER_ENDPOINT_INVALID. */
const CODE_MESSAGE = /^[A-Z][A-Z0-9_]*(?: [a-z]+=\S+)*$/u

/** The HTTP status an MCP client error (SdkHttpError) carries, if any. */
const httpStatus = (error: unknown, depth = 0): number | undefined => {
  if (typeof error !== "object" || error === null || depth > 3) {
    return undefined
  }
  const { status, cause } = error as { status?: unknown; cause?: unknown }
  return typeof status === "number" && status >= 100 && status <= 599 ?
      status
    : httpStatus(cause, depth + 1)
}

const errorCode = (error: unknown): string => {
  if (error instanceof ContainmentError) {
    return describeContainmentError(error)
  }
  if (error instanceof BrokerStartupError) {
    return error.code
  }
  if (error instanceof ControlProtocolError) {
    return error.code
  }
  if (error instanceof Error && CODE_MESSAGE.test(error.message)) {
    return error.message
  }
  return "BROKER_INTERNAL_ERROR"
}

class UsageError extends Error {
  constructor() {
    super("USAGE")
    this.name = "UsageError"
  }
}

const serve = async (options: ServeOptions): Promise<void> => {
  const decoder = new ControlFrameDecoder()
  const sequence = new ControlSequenceValidator(options.generation)
  const writer = new ControlWriter(options.generation)
  const elicitations = new MaximalElicitations((frame) =>
    writer.send({ deadlineMs: Date.now() + MESSAGE_DEADLINE_MS, ...frame }),
  )
  let running: RunningBrokerServer | undefined
  let heartbeat: ReturnType<typeof setInterval> | undefined
  let stopping = false

  const close = async (): Promise<void> => {
    if (stopping) {
      return
    }
    stopping = true
    if (heartbeat) {
      clearInterval(heartbeat)
    }
    elicitations.cancelAll()
    await running?.close()
    running = undefined
  }

  // A session's open event stream can hold the HTTP server's close
  // indefinitely, so a broker on its way out exits anyway once the grace
  // period is up. On Windows, exiting ends the Job Object and every server
  // with it.
  let forcedExit: ReturnType<typeof setTimeout> | undefined
  const armForcedExit = () => {
    forcedExit ??= setTimeout(
      () => process.exit(process.exitCode ?? 0),
      TERMINATE_GRACE_MS,
    )
    forcedExit.unref()
  }
  const terminate = () => {
    armForcedExit()
    void close().finally(() => {
      process.exitCode = 0
      process.stdin.destroy()
    })
  }
  process.once("SIGINT", terminate)
  process.once("SIGTERM", terminate)

  let parentWatchdog: ReturnType<typeof setInterval> | undefined
  if (options.parentPid !== undefined) {
    parentWatchdog = setInterval(() => {
      try {
        process.kill(options.parentPid as number, 0)
      } catch {
        if (parentWatchdog) clearInterval(parentWatchdog)
        process.stderr.write("[maximal-mcp-broker] PARENT_EXITED\n")
        terminate()
      }
    }, 1_000)
    parentWatchdog.unref()
  }

  await writer.send({
    deadlineMs: Date.now() + MESSAGE_DEADLINE_MS,
    operation: "hello",
    payload: { binaryVersion: BINARY_VERSION },
  })

  try {
    for await (const chunk of process.stdin) {
      const envelopes = decoder.push(chunk as Uint8Array)
      for (const envelope of envelopes) {
        sequence.accept(envelope)

        // An answer is delivered (or dropped, if no longer awaited) however
        // late; it is never itself answered.
        if (envelope.operation === "elicitResult") {
          elicitations.settle(envelope.requestId, envelope.payload)
          continue
        }

        if (Date.now() > envelope.deadlineMs) {
          if (envelope.requestId) {
            await writer.send({
              deadlineMs: Date.now() + MESSAGE_DEADLINE_MS,
              operation: "response",
              requestId: envelope.requestId,
              payload: { ok: false, code: "DEADLINE_EXCEEDED" },
            })
          }
          continue
        }

        if (envelope.operation === "configure") {
          if (running) {
            await writer.send({
              deadlineMs: Date.now() + MESSAGE_DEADLINE_MS,
              operation: "response",
              requestId: envelope.requestId,
              payload: { ok: false, code: "ALREADY_CONFIGURED" },
            })
            continue
          }

          try {
            running = await startBrokerServer(
              envelope.payload.configuration,
              envelope.payload.apiKey,
              { askMaximal: elicitations.ask },
            )
          } catch (error) {
            await writer.send({
              deadlineMs: Date.now() + MESSAGE_DEADLINE_MS,
              operation: "response",
              requestId: envelope.requestId,
              payload: { ok: false, code: errorCode(error) },
            })
            await writer.send({
              deadlineMs: Date.now() + MESSAGE_DEADLINE_MS,
              operation: "status",
              payload: { state: "degraded" },
            })
            throw error
          }

          await writer.send({
            deadlineMs: Date.now() + MESSAGE_DEADLINE_MS,
            operation: "response",
            requestId: envelope.requestId,
            payload: { ok: true },
          })
          await writer.send({
            deadlineMs: Date.now() + MESSAGE_DEADLINE_MS,
            operation: "ready",
            payload: {
              host: running.host,
              port: running.port,
              endpoints: running.endpoints,
            },
          })
          await writer.send({
            deadlineMs: Date.now() + MESSAGE_DEADLINE_MS,
            operation: "status",
            payload: { state: "ready" },
          })

          heartbeat = setInterval(() => {
            void writer
              .send({
                deadlineMs: Date.now() + MESSAGE_DEADLINE_MS,
                operation: "heartbeat",
                payload: { sentAtMs: Date.now() },
              })
              .catch(terminate)
          }, envelope.payload.configuration.heartbeatIntervalMs)
          heartbeat.unref()
          continue
        }

        if (envelope.operation === "update") {
          let payload:
            | { ok: true }
            | { ok: false; code: string } = { ok: true }
          if (!running) {
            payload = { ok: false, code: "NOT_CONFIGURED" }
          } else {
            try {
              running.update(envelope.payload.configuration)
            } catch (error) {
              payload = { ok: false, code: errorCode(error) }
            }
          }
          await writer.send({
            deadlineMs: Date.now() + MESSAGE_DEADLINE_MS,
            operation: "response",
            requestId: envelope.requestId,
            payload,
          })
          continue
        }

        if (envelope.operation === "shutdown") {
          armForcedExit()
          await close()
          await writer.send({
            deadlineMs: Date.now() + MESSAGE_DEADLINE_MS,
            operation: "response",
            requestId: envelope.requestId,
            payload: { ok: true },
          })
          return
        }

        throw new ControlProtocolError("CONTROL_FRAME_SCHEMA_INVALID")
      }
    }

    decoder.finish()
  } finally {
    if (parentWatchdog) {
      clearInterval(parentWatchdog)
    }
    process.off("SIGINT", terminate)
    process.off("SIGTERM", terminate)
    // However serving ended (shutdown, stdin closed because the sidecar is
    // gone, or an error), closing must not keep the broker running.
    armForcedExit()
    await close()
  }
}

const main = async (): Promise<void> => {
  const [mode, ...args] = process.argv.slice(2)
  if (mode === "--version" || mode === "-v" || mode === "version") {
    process.stdout.write(
      `maximal-mcp-broker ${BINARY_VERSION} (control protocol ${CONTROL_PROTOCOL_VERSION})\n`,
    )
    return
  }
  if (
    mode === "--help"
    || mode === "-h"
    || mode === "help"
    || args.includes("--help")
    || args.includes("-h")
  ) {
    process.stdout.write(USAGE)
    return
  }
  if (mode === "serve") {
    // On Windows, before anything can start a process: everything this
    // broker starts must end when it does.
    containInKillOnCloseJob()
    const restoreDiagnostics = installSanitizedDependencyDiagnostics()
    try {
      await serve(parseServeOptions(args))
    } finally {
      restoreDiagnostics()
    }
    // Done serving. A server that didn't exit when it was closed can still
    // hold pipes to this process and keep it running: on Windows one started
    // through cmd.exe outlives the cmd.exe that was ended. Exit instead,
    // which on Windows also ends the Job Object and that server with it.
    process.exit(process.exitCode ?? 0)
  }
  if (mode === "stdio-adapter") {
    const url = parseAdapterUrl(args)
    const restoreDiagnostics = installSanitizedDependencyDiagnostics()
    try {
      await runStdioAdapter({ url })
    } catch (error) {
      if (error instanceof Error && CODE_MESSAGE.test(error.message)) {
        throw error
      }
      // Couldn't reach the endpoint, or it refused (401 without a key).
      const status = httpStatus(error)
      throw new Error(
        `ADAPTER_CONNECT_FAILED${status === undefined ? "" : ` status=${status}`}`,
        { cause: error },
      )
    } finally {
      restoreDiagnostics()
    }
    return
  }
  throw new UsageError()
}

void main().catch((error: unknown) => {
  if (error instanceof UsageError) {
    process.stderr.write(USAGE)
  }
  const code = errorCode(error)
  let status = 1
  if (error instanceof ContainmentError) status = CONTAINMENT_EXIT_CODE
  else if (error instanceof UsageError) status = 2
  process.exitCode = status
  // Exit once the line is out: servers a failed `serve` started could
  // otherwise keep this process running.
  process.stderr.write(`[maximal-mcp-broker] ${code}\n`, () =>
    process.exit(status),
  )
})
