import process from "node:process"

const WINDOW_MS = 60_000
const MAX_MESSAGES_PER_WINDOW = 10
const METHODS = ["debug", "error", "info", "log", "trace", "warn"] as const

type DiagnosticMethod = (typeof METHODS)[number]

export const installSanitizedDependencyDiagnostics = (): (() => void) => {
  const originals = Object.fromEntries(
    METHODS.map((method) => [method, console[method]]),
  ) as Record<DiagnosticMethod, typeof console.error>
  let windowStartedAt = Date.now()
  let messages = 0

  const diagnostic = () => {
    const now = Date.now()
    if (now - windowStartedAt >= WINDOW_MS) {
      windowStartedAt = now
      messages = 0
    }
    if (messages >= MAX_MESSAGES_PER_WINDOW) {
      return
    }

    messages += 1
    process.stderr.write("[maximal-mcp-broker] DEPENDENCY_DIAGNOSTIC\n")
  }
  for (const method of METHODS) {
    console[method] = diagnostic
  }

  return () => {
    for (const method of METHODS) {
      console[method] = originals[method]
    }
  }
}
