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
import { runStdioAdapter } from "./stdio-adapter.ts"

const BINARY_VERSION = "0.0.0"
const MESSAGE_DEADLINE_MS = 10_000

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
    throw new Error(
      "stdio-adapter requires --url <http://127.0.0.1:<port>/mcp/<id>>",
    )
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

const errorCode = (error: unknown): string => {
  if (error instanceof BrokerStartupError) {
    return error.code
  }
  if (error instanceof ControlProtocolError) {
    return error.code
  }
  return "BROKER_INTERNAL_ERROR"
}

const serve = async (options: ServeOptions): Promise<void> => {
  const decoder = new ControlFrameDecoder()
  const sequence = new ControlSequenceValidator(options.generation)
  const writer = new ControlWriter(options.generation)
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
    await running?.close()
    running = undefined
  }

  const terminate = () => {
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

        if (envelope.operation === "shutdown") {
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
    await close()
  }
}

const main = async (): Promise<void> => {
  const [mode, ...args] = process.argv.slice(2)
  if (mode === "serve") {
    const restoreDiagnostics = installSanitizedDependencyDiagnostics()
    try {
      await serve(parseServeOptions(args))
    } finally {
      restoreDiagnostics()
    }
    return
  }
  if (mode === "stdio-adapter") {
    const restoreDiagnostics = installSanitizedDependencyDiagnostics()
    try {
      await runStdioAdapter({ url: parseAdapterUrl(args) })
    } finally {
      restoreDiagnostics()
    }
    return
  }
  throw new Error("expected serve or stdio-adapter mode")
}

void main().catch((error: unknown) => {
  const code = errorCode(error)
  process.stderr.write(`[maximal-mcp-broker] ${code}\n`)
  process.exitCode = 1
})
