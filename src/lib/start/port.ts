/**
 * Port pre-flight: probe the configured port and bail out with a
 * useful diagnostic before spending several seconds on Copilot
 * bootstrap. Also: optional eviction of a stale prior maximal
 * instance via the `--replace` flag.
 */

import consola from "consola"

import { getConfiguredApiKeys } from "~/lib/auth/request-auth"
import { evictRunning } from "~/lib/platform/replace-running"

/** Wrap evictRunning() with the CLI's error-handling. On failure to
 *  free the port we exit 1 with a readable message rather than dumping
 *  a stack trace. */
export async function maybeEvictRunning(port: number): Promise<void> {
  const keys = getConfiguredApiKeys()
  const apiKey = keys[0] ?? null
  try {
    await evictRunning({ apiKey, port })
  } catch (error) {
    consola.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}

/** Print a friendly explanation of why the port is held and exit 1.
 *  Diagnostic differentiates "another maximal" from "something else." */
export function reportPortBusyAndExit(
  port: number,
  occupant: "maximal" | "other",
): never {
  if (occupant === "maximal") {
    consola.error(
      [
        `Port ${port} is already in use by another maximal instance.`,
        ``,
        `Options:`,
        `  • Re-run with --replace to evict it.`,
        `  • Stop the other instance and try again.`,
        `  • Pass --port <n> to use a different port.`,
      ].join("\n"),
    )
  } else {
    const lookupHint =
      process.platform === "darwin" || process.platform === "linux" ?
        `lsof -i :${port}`
      : `Get-Process -Id (Get-NetTCPConnection -LocalPort ${port}).OwningProcess`
    consola.error(
      [
        `Port ${port} is in use by another process (not maximal).`,
        ``,
        `Pass --port <n> to use a different port, or stop the other process.`,
        ``,
        `Find the offender with:`,
        `    ${lookupHint}`,
      ].join("\n"),
    )
  }
  process.exit(1)
}

export async function probePort(
  port: number,
): Promise<"free" | "maximal" | "other"> {
  try {
    const res = await fetch(`http://localhost:${port}/`, {
      signal: AbortSignal.timeout(500),
    })
    if (!res.ok) return "other"
    const text = (await res.text()).trim()
    return text === "Server running" ? "maximal" : "other"
  } catch {
    return "free"
  }
}
