import consola, { type ConsolaInstance } from "consola"
import fs from "node:fs"
import path from "node:path"
import util from "node:util"

import { getLogRetentionDays } from "./config"
import { redactForLog, scrubSecrets } from "./log-redact"
import { PATHS } from "./paths"
import { registerProcessCleanup } from "./process-cleanup"
import { requestContext } from "./request-context"
import { state } from "./state"

const ONE_DAY_MS = 24 * 60 * 60 * 1000
const CLEANUP_INTERVAL_MS = ONE_DAY_MS
const LOG_DIR = path.join(PATHS.APP_DIR, "logs")
const FLUSH_INTERVAL_MS = 1000
const MAX_BUFFER_SIZE = 100

const logStreams = new Map<string, fs.WriteStream>()
const logBuffers = new Map<string, Array<string>>()

let runtimeInitialized = false
let flushInterval: ReturnType<typeof setInterval> | undefined
let cleanupInterval: ReturnType<typeof setInterval> | undefined

const ensureLogDirectory = () => {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true })
  }
}

const cleanupOldLogs = () => {
  if (!fs.existsSync(LOG_DIR)) {
    return
  }

  const retentionMs = getLogRetentionDays() * ONE_DAY_MS
  const now = Date.now()

  for (const entry of fs.readdirSync(LOG_DIR)) {
    const filePath = path.join(LOG_DIR, entry)

    let stats: fs.Stats
    try {
      stats = fs.statSync(filePath)
    } catch {
      continue
    }

    if (!stats.isFile()) {
      continue
    }

    // retentionMs === 0 → delete every file unconditionally
    // (ephemeral / container deployments).
    if (retentionMs === 0 || now - stats.mtimeMs > retentionMs) {
      try {
        fs.rmSync(filePath)
      } catch {
        continue
      }
    }
  }
}

const formatArgs = (args: Array<unknown>) =>
  args
    .map((arg) =>
      typeof arg === "string" ? arg : (
        util.inspect(arg, { depth: null, colors: false })
      ),
    )
    .join(" ")

const sanitizeName = (name: string) => {
  const normalized = name
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "")

  return normalized === "" ? "handler" : normalized
}

const maybeUnref = (timer: ReturnType<typeof setInterval>) => {
  timer.unref()
}

const flushBuffer = (filePath: string) => {
  const buffer = logBuffers.get(filePath)
  if (!buffer || buffer.length === 0) {
    return
  }

  const stream = getLogStream(filePath)
  const content = buffer.join("\n") + "\n"
  stream.write(content, (error) => {
    if (error) {
      console.warn("Failed to write handler log", error)
    }
  })

  logBuffers.set(filePath, [])
}

const flushAllBuffers = () => {
  for (const filePath of logBuffers.keys()) {
    flushBuffer(filePath)
  }
}

const cleanup = () => {
  if (flushInterval) {
    clearInterval(flushInterval)
    flushInterval = undefined
  }
  if (cleanupInterval) {
    clearInterval(cleanupInterval)
    cleanupInterval = undefined
  }

  flushAllBuffers()
  for (const stream of logStreams.values()) {
    stream.end()
  }
  logStreams.clear()
  logBuffers.clear()
}

const initializeLoggerRuntime = () => {
  if (runtimeInitialized) {
    return
  }

  runtimeInitialized = true

  ensureLogDirectory()
  cleanupOldLogs()

  flushInterval = setInterval(flushAllBuffers, FLUSH_INTERVAL_MS)
  maybeUnref(flushInterval)

  cleanupInterval = setInterval(cleanupOldLogs, CLEANUP_INTERVAL_MS)
  maybeUnref(cleanupInterval)

  registerProcessCleanup(cleanup)
}

const getLogStream = (filePath: string): fs.WriteStream => {
  initializeLoggerRuntime()

  let stream = logStreams.get(filePath)
  if (!stream || stream.destroyed) {
    stream = fs.createWriteStream(filePath, { flags: "a" })
    logStreams.set(filePath, stream)

    stream.on("error", (error: unknown) => {
      console.warn("Log stream error", error)
      logStreams.delete(filePath)
    })
  }
  return stream
}

const appendLine = (filePath: string, line: string) => {
  let buffer = logBuffers.get(filePath)
  if (!buffer) {
    buffer = []
    logBuffers.set(filePath, buffer)
  }

  buffer.push(line)

  if (buffer.length >= MAX_BUFFER_SIZE) {
    flushBuffer(filePath)
  }
}

type DebugLogger = Pick<ConsolaInstance, "debug">

/**
 * Redact every non-string argument before it reaches the log reporter.
 * String args are treated as caller-supplied labels (e.g. "Request
 * payload:") and kept; objects/arrays are payloads and run through the
 * fail-closed redactor so message content never lands on disk. This is
 * the single chokepoint — all handler payload logging flows through
 * `debugLazy`, so redaction here covers every current and future call
 * site without per-handler discipline.
 */
const redactArgs = (
  args: [unknown, ...Array<unknown>],
): [unknown, ...Array<unknown>] => {
  return args.map((arg) =>
    typeof arg === "string" ? arg : redactForLog(arg),
  ) as [unknown, ...Array<unknown>]
}

export const debugLazy = (
  logger: DebugLogger,
  factory: () => [unknown, ...Array<unknown>],
): void => {
  if (!state.verbose) {
    return
  }

  logger.debug(...redactArgs(factory()))
}

export const debugJson = (
  logger: DebugLogger,
  label: string,
  value: unknown,
): void => {
  debugLazy(logger, () => [label, JSON.stringify(redactForLog(value))])
}

export const debugJsonTail = (
  logger: DebugLogger,
  label: string,
  { value, tailLength = 400 }: { value: unknown; tailLength?: number },
): void => {
  debugLazy(logger, () => [
    label,
    JSON.stringify(redactForLog(value)).slice(-tailLength),
  ])
}

/** The subset of consola's surface our runtime call sites use. */
export interface TeeLogger {
  info: (...args: Array<unknown>) => void
  warn: (...args: Array<unknown>) => void
  error: (...args: Array<unknown>) => void
  debug: (...args: Array<unknown>) => void
}

/**
 * A logger that writes through the GLOBAL `consola` (so the dev console — and
 * any test that spies on `consola.warn`/`.error` — still sees every line) AND
 * tees a redacted copy to a dated `<name>-YYYY-MM-DD.log` in the logs dir. This
 * is the seam that makes runtime events (especially auth: sign-in, degrade,
 * refresh retries, sign-out) OBSERVABLE AFTER THE FACT instead of vanishing
 * into stderr / the Tauri dev terminal where they can't be inspected later.
 *
 * The file copy redacts non-string args (matching the handler-logger
 * discipline) so a logged error object can't leak a token to disk; string args
 * are caller labels and kept. `debug` only writes (console + file) when verbose.
 */
export const createTeeLogger = (name: string): TeeLogger => {
  const sanitizedName = sanitizeName(name)
  // consola's typed signature won't accept a spread of `unknown[]`; alias to a
  // permissive shape so we can forward variadic args straight through.
  const c = consola as unknown as TeeLogger

  const writeFile = (type: string, args: Array<unknown>) => {
    initializeLoggerRuntime()
    const context = requestContext.getStore()
    const traceId = context?.traceId
    const now = new Date()
    const dateKey = now.toLocaleDateString("sv-SE")
    const timestamp = now.toLocaleString("sv-SE", { hour12: false })
    const filePath = path.join(LOG_DIR, `${sanitizedName}-${dateKey}.log`)
    // Object args run through the key-driven redactor; string args (labels,
    // interpolated messages) through the secret-pattern scrubber so a token
    // passed/interpolated as a bare string can't land on disk unmasked.
    const redacted = args.map((arg) =>
      typeof arg === "string" ? scrubSecrets(arg) : redactForLog(arg),
    )
    const message = formatArgs(redacted)
    const traceIdStr = traceId ? ` [${traceId}]` : ""
    appendLine(
      filePath,
      `[${timestamp}] [${type}] [${name}]${traceIdStr}${message ? ` ${message}` : ""}`,
    )
  }

  // Each level forwards to console then tees the same args to the file sink.
  // `c[type]` is looked up at call time (not captured) so tests that swap
  // `consola.warn`/`.error` for a spy after construction still intercept it.
  const tee =
    (type: "info" | "warn" | "error" | "debug") =>
    (...args: Array<unknown>) => {
      c[type](...args)
      writeFile(type, args)
    }

  return {
    info: tee("info"),
    warn: tee("warn"),
    error: tee("error"),
    debug: (...args) => {
      if (!state.verbose) return
      tee("debug")(...args)
    },
  }
}

export const createHandlerLogger = (name: string): ConsolaInstance => {
  const sanitizedName = sanitizeName(name)
  const instance = consola.withTag(name)

  if (state.verbose) {
    instance.level = 5
  }
  instance.setReporters([])

  instance.addReporter({
    log(logObj) {
      initializeLoggerRuntime()

      const context = requestContext.getStore()
      const traceId = context?.traceId
      const date = logObj.date
      const dateKey = date.toLocaleDateString("sv-SE")
      const timestamp = date.toLocaleString("sv-SE", { hour12: false })
      const filePath = path.join(LOG_DIR, `${sanitizedName}-${dateKey}.log`)
      const message = formatArgs(logObj.args as Array<unknown>)
      const traceIdStr = traceId ? ` [${traceId}]` : ""
      const line = `[${timestamp}] [${logObj.type}] [${logObj.tag || name}]${traceIdStr}${
        message ? ` ${message}` : ""
      }`

      appendLine(filePath, line)
    },
  })

  return instance
}
