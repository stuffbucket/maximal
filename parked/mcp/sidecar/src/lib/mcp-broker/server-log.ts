/**
 * The broker's stderr, in Maximal's log. The broker writes its own
 * sanitized codes there, and each MCP server's stderr tagged with its
 * endpoint (`[endpoint:<id>] <line>`). Both go to the `mcp-broker` daily
 * log; for each endpoint the last line that reads like a problem is kept in
 * memory, so Settings can show why a server isn't working (Work IQ reports
 * sign-in and permission failures only there).
 */

import { createTeeLogger } from "~/lib/platform/logger"

export interface ServerProblemLine {
  line: string
  /** When it was written, in ms since the epoch. */
  at: number
}

interface LineLogger {
  info: (...args: Array<unknown>) => void
  warn: (...args: Array<unknown>) => void
}

const ENDPOINT_LINE = /^\[endpoint:([\w.-]{1,64})\] (.*)$/su
const PROBLEM =
  /\b(?:error|errors|fail|failed|failure|denied|unauthori[sz]ed|forbidden|exception|AADSTS\d+|eula)\b/iu
const MAX_LINE_CHARS = 2000
const WINDOW_MS = 60_000
const MAX_LINES_PER_WINDOW = 120

/** Feed it a stream's chunks; calls `onLine` with each non-blank line. */
export function createLineSplitter(
  onLine: (line: string) => void,
): (chunk: Buffer | string) => void {
  let partial = ""
  return (chunk) => {
    const lines = (partial + chunk.toString()).split("\n")
    partial = lines.pop() ?? ""
    if (partial.length > MAX_LINE_CHARS) {
      lines.push(partial)
      partial = ""
    }
    for (const raw of lines) {
      const line = raw.trim().slice(0, MAX_LINE_CHARS)
      if (line) onLine(line)
    }
  }
}

export class BrokerStderrLog {
  readonly #logger: () => LineLogger
  readonly #now: () => number
  readonly #problems = new Map<string, ServerProblemLine>()
  #windowStartedAt: number
  #written = 0
  #dropped = 0

  constructor(
    logger: LineLogger | (() => LineLogger),
    now: () => number = Date.now,
  ) {
    this.#logger = typeof logger === "function" ? logger : () => logger
    this.#now = now
    this.#windowStartedAt = now()
  }

  record(line: string): void {
    const match = ENDPOINT_LINE.exec(line)
    if (match) {
      const [, id, text] = match
      if (PROBLEM.test(text)) {
        this.#problems.set(id, { line: text, at: this.#now() })
      }
      this.#write("info", `${id}: ${text}`)
      return
    }
    this.#write("warn", line)
  }

  /** The last line endpoint `id`'s server wrote that reads like a problem. */
  lastProblem(id: string): ServerProblemLine | undefined {
    return this.#problems.get(id)
  }

  /** Start over for `id`, e.g. before trying again after signing in. */
  forget(id: string): void {
    this.#problems.delete(id)
  }

  #write(level: "info" | "warn", text: string): void {
    const now = this.#now()
    if (now - this.#windowStartedAt >= WINDOW_MS) {
      this.#windowStartedAt = now
      this.#written = 0
      if (this.#dropped > 0) {
        this.#logger().warn(
          `MCP server output: ${this.#dropped} lines dropped in the last minute`,
        )
        this.#dropped = 0
      }
    }
    if (this.#written >= MAX_LINES_PER_WINDOW) {
      this.#dropped += 1
      return
    }
    this.#written += 1
    this.#logger()[level](text)
  }
}

let teeLogger: LineLogger | undefined

/** Maximal's own: the `mcp-broker-<date>.log` daily log. */
export const brokerStderrLog = new BrokerStderrLog(() => {
  teeLogger ??= createTeeLogger("mcp-broker")
  return teeLogger
})

export function recordBrokerStderr(line: string): void {
  brokerStderrLog.record(line)
}
