/**
 * What an MCP server writes to stderr, passed up to Maximal so it lands in
 * Maximal's log and the Settings card can show the last problem. Sign-in
 * and permission failures (Work IQ's "Failed to fetch remote tools", say)
 * show up only there.
 *
 * Lines are cleaned of terminal escapes and control characters, shortened,
 * and limited per endpoint per minute, so a chatty server can't flood the
 * control channel's neighbour or the log.
 */

export const SERVER_STDERR_MAX_LINE_CHARS = 500
export const SERVER_STDERR_MAX_LINES = 30
const WINDOW_MS = 60_000

/** Where a cleaned line goes. */
export type StderrLineSink = (line: string) => void

/** A server's stderr line, for the broker's own stderr. The sidecar reads
 *  the endpoint id back from the tag. */
export const formatServerStderr = (endpointId: string, line: string): string =>
  `[endpoint:${endpointId}] ${line}\n`

// eslint-disable-next-line no-control-regex
const ESCAPES = /\u001B\[[\d;?]*[A-Za-z]|\u001B\][^\u0007]*\u0007/gu
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001F\u007F]/gu

const clean = (line: string): string => {
  const text = line.replaceAll(ESCAPES, "").replaceAll(CONTROL, "").trim()
  return text.length > SERVER_STDERR_MAX_LINE_CHARS ?
      `${text.slice(0, SERVER_STDERR_MAX_LINE_CHARS - 1)}…`
    : text
}

/**
 * A function to feed a stream's chunks to. Every instance of an endpoint
 * (the startup probe and each session's) shares one forwarder, so the limit
 * is per endpoint.
 */
export const createStderrForwarder = (
  sink: StderrLineSink,
  now: () => number = Date.now,
): ((chunk: Buffer | string) => void) => {
  let partial = ""
  let windowStartedAt = now()
  let sent = 0
  let dropped = 0

  const emit = (raw: string) => {
    const line = clean(raw)
    if (!line) return
    if (now() - windowStartedAt >= WINDOW_MS) {
      windowStartedAt = now()
      sent = 0
      if (dropped > 0) {
        sink(`(${dropped} lines dropped)`)
        dropped = 0
      }
    }
    if (sent >= SERVER_STDERR_MAX_LINES) {
      dropped += 1
      return
    }
    sent += 1
    sink(line)
  }

  return (chunk) => {
    const lines = (partial + chunk.toString()).split("\n")
    partial = lines.pop() ?? ""
    // A line with no end in sight is passed on as it is.
    if (partial.length > SERVER_STDERR_MAX_LINE_CHARS * 2) {
      lines.push(partial)
      partial = ""
    }
    for (const line of lines) emit(line)
  }
}
