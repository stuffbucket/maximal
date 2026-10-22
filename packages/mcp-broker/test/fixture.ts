import {
  inputRequired,
  inputResponse,
  Server,
  type CallToolResult,
  type InputRequiredResult,
  type ServerContext,
} from "@modelcontextprotocol/server"
import { serveStdio } from "@modelcontextprotocol/server/stdio"
import { writeFileSync } from "node:fs"

const MODERN_PROTOCOL_VERSION = "2026-07-28"
const REQUEST_STATE = "fixture-state-v1"
const cancellationFile = process.env.SPIKE_FIXTURE_CANCEL_FILE

type FixtureEra = "both" | "legacy" | "modern"
type TerminalAction = "accept" | "cancel" | "decline"

function parseEra(args: Array<string>): FixtureEra {
  const index = args.indexOf("--era")
  const value = index === -1 ? "both" : args[index + 1]

  if (value === "both" || value === "legacy" || value === "modern") {
    return value
  }

  throw new Error(`Invalid --era value: ${value ?? "missing"}`)
}

function textResult(text: string): CallToolResult {
  return {
    content: [{ type: "text", text }],
  }
}

function formRequest(message: string) {
  return {
    mode: "form" as const,
    message,
    requestedSchema: {
      type: "object" as const,
      properties: {
        confirmed: {
          type: "boolean" as const,
          title: "Confirm",
        },
      },
      required: ["confirmed"],
    },
  }
}

function modernInputRequest(key: string, message: string): InputRequiredResult {
  return inputRequired({
    inputRequests: {
      [key]: inputRequired.elicit(formRequest(message)),
    },
    requestState: REQUEST_STATE,
  })
}

function readTerminalAction(
  ctx: ServerContext,
  key: string,
): TerminalAction | undefined {
  const response = inputResponse(ctx.mcpReq.inputResponses, key)
  return response.kind === "elicit" ? response.action : undefined
}

function terminalResult(
  action: TerminalAction,
  roundCount: number,
): CallToolResult {
  return textResult(`terminal:${action}:rounds:${roundCount}`)
}

async function handleModernInteraction(
  toolName: string,
  ctx: ServerContext,
): Promise<CallToolResult | InputRequiredResult> {
  const echoedState = ctx.mcpReq.requestState<string>()
  const firstAction = readTerminalAction(ctx, "first")
  const secondAction = readTerminalAction(ctx, "second")

  if (echoedState !== undefined && echoedState !== REQUEST_STATE) {
    return {
      content: [{ type: "text", text: "request-state-mismatch" }],
      isError: true,
    }
  }

  if (toolName === "interactive_never") {
    return modernInputRequest("never", "Continue the bounded-round fixture?")
  }

  if (firstAction === undefined) {
    return modernInputRequest("first", "Confirm the first fixture round.")
  }

  if (firstAction !== "accept") {
    return terminalResult(firstAction, 1)
  }

  if (toolName === "interactive_one") {
    return terminalResult("accept", 1)
  }

  if (secondAction === undefined) {
    return modernInputRequest("second", "Confirm the second fixture round.")
  }

  return terminalResult(secondAction, 2)
}

async function handleLegacyInteraction(
  toolName: string,
  ctx: ServerContext,
): Promise<CallToolResult> {
  const first = await ctx.mcpReq.elicitInput(
    formRequest("Confirm the first legacy fixture round."),
  )

  if (first.action !== "accept" || toolName === "interactive_one") {
    return terminalResult(first.action, 1)
  }

  const second = await ctx.mcpReq.elicitInput(
    formRequest("Confirm the second legacy fixture round."),
  )
  return terminalResult(second.action, 2)
}

/** Legacy-only requests for user input beyond the single-boolean form. */
async function handleLegacyVariant(
  toolName: string,
  ctx: ServerContext,
): Promise<CallToolResult> {
  if (toolName === "interactive_url") {
    const result = await ctx.mcpReq.elicitInput({
      mode: "url",
      message: "Open the fixture page.",
      url: "https://fixture.example/consent",
      elicitationId: "fixture-url-1",
    })
    return textResult(`terminal:${result.action}`)
  }
  if (toolName === "interactive_sensitive") {
    const result = await ctx.mcpReq.elicitInput({
      mode: "form",
      message: "Enter your password.",
      requestedSchema: {
        type: "object",
        properties: { password: { type: "string", title: "Password" } },
        required: ["password"],
      },
    })
    return textResult(`terminal:${result.action}`)
  }
  // interactive_echo: a richer form whose answer comes back verbatim.
  const result = await ctx.mcpReq.elicitInput({
    mode: "form",
    message: "Fill in the fixture form.",
    requestedSchema: {
      type: "object",
      properties: {
        confirmed: { type: "boolean", title: "Confirm" },
        note: { type: "string", title: "Note", maxLength: 40 },
        count: { type: "integer", title: "Count", minimum: 1, maximum: 5 },
        color: { type: "string", title: "Color", enum: ["red", "blue"] },
      },
      required: ["confirmed"],
    },
  })
  return textResult(
    `terminal:${result.action}:${JSON.stringify(result.content ?? {})}`,
  )
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const complete = () => {
      signal.removeEventListener("abort", abort)
      resolve()
    }
    const timer = setTimeout(complete, ms)
    const abort = () => {
      clearTimeout(timer)
      signal.removeEventListener("abort", abort)
      if (cancellationFile !== undefined) {
        writeFileSync(cancellationFile, "cancelled")
      }
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"))
    }

    if (signal.aborted) {
      abort()
      return
    }

    signal.addEventListener("abort", abort, { once: true })
  })
}

function createFixtureServer(era: "legacy" | "modern"): Server {
  const seenModernRequestIds = new Set<string | number>()
  const server = new Server(
    { name: "workiq-elicitation-fixture", version: "0.0.0" },
    {
      capabilities: { tools: {} },
      inputRequired: { legacyShim: false },
      supportedProtocolVersions:
        era === "modern" ? [MODERN_PROTOCOL_VERSION] : undefined,
    },
  )

  server.setRequestHandler("tools/list", async () => ({
    tools: [
      "ordinary",
      "interactive_one",
      "interactive_two",
      "interactive_never",
      "interactive_echo",
      "interactive_url",
      "interactive_sensitive",
      "progress",
      "delay",
      "whoami",
    ].map((name) => ({
      name,
      description: `Deterministic fixture tool: ${name}`,
      inputSchema: {
        type: "object" as const,
        properties: {},
        additionalProperties: false,
      },
    })),
  }))

  server.setRequestHandler("tools/call", async (request, ctx) => {
    if (era === "modern") {
      if (seenModernRequestIds.has(ctx.mcpReq.id)) {
        return {
          content: [{ type: "text", text: "request-id-reused" }],
          isError: true,
        }
      }
      seenModernRequestIds.add(ctx.mcpReq.id)
    }

    switch (request.params.name) {
      case "ordinary": {
        return textResult("ordinary-ok")
      }
      case "interactive_one":
      case "interactive_two":
      case "interactive_never": {
        return era === "modern" ?
            handleModernInteraction(request.params.name, ctx)
          : handleLegacyInteraction(request.params.name, ctx)
      }
      case "interactive_echo":
      case "interactive_url":
      case "interactive_sensitive": {
        return era === "modern" ?
            textResult("legacy-only")
          : handleLegacyVariant(request.params.name, ctx)
      }
      case "progress": {
        const progressToken = ctx.mcpReq._meta?.progressToken
        if (progressToken !== undefined) {
          await ctx.mcpReq.notify({
            method: "notifications/progress",
            params: { progress: 1, total: 2, progressToken },
          })
          await ctx.mcpReq.notify({
            method: "notifications/progress",
            params: { progress: 2, total: 2, progressToken },
          })
        }
        return textResult("progress-ok")
      }
      case "whoami": {
        return textResult(`pid:${process.pid}`)
      }
      case "delay": {
        await wait(5_000, ctx.mcpReq.signal)
        return textResult("delay-ok")
      }
      default: {
        return {
          content: [{ type: "text", text: "unknown-tool" }],
          isError: true,
        }
      }
    }
  })

  return server
}

const fixtureEra = parseEra(process.argv.slice(2))
const pidFile = process.env.SPIKE_FIXTURE_PID_FILE
if (pidFile !== undefined) {
  writeFileSync(pidFile, String(process.pid))
}
const handle = serveStdio(
  ({ era }) => {
    if (fixtureEra !== "both" && fixtureEra !== era) {
      throw new Error(`Fixture is restricted to ${fixtureEra} protocol traffic`)
    }
    return createFixtureServer(era)
  },
  { legacy: fixtureEra === "modern" ? "reject" : "serve" },
)

console.error(`[fixture] ready era=${fixtureEra}`)

async function close(): Promise<void> {
  await handle.close()
}

process.once("SIGINT", () => {
  void close()
})
process.once("SIGTERM", () => {
  void close()
})
