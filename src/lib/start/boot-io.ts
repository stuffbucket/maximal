/**
 * Per-boot startup logger + user-facing "ready" banner.
 *
 * The boot logger writes to `~/.local/share/maximal/logs/startup-<date>.log`
 * via the same handler-logger machinery as `/v1/messages`. The first write
 * creates the logs directory so "Reveal logs in Finder" lands somewhere
 * even on first boot, and the per-restart record gives operators an audit
 * trail stdout alone can't answer.
 *
 * The banner is a one-shot human-facing summary printed at "about to bind"
 * time — lists the URL surfaces and hints at the faster `app:ui` HMR loop
 * for HTML/CSS/TS work.
 */

import consola from "consola"

import { createHandlerLogger } from "~/lib/platform/logger"
import { shortSha, type GitVersion } from "~/lib/update/version"

interface BootLoggerOptions {
  port: number
  accountType: string
}

export function initBootLogger(
  git: GitVersion,
  options: BootLoggerOptions,
): ReturnType<typeof createHandlerLogger> {
  const logger = createHandlerLogger("startup")
  logger.info(
    `maximal start pid=${process.pid} `
      + `version=${git.sha ? shortSha(git.sha) : "unknown"} `
      + `branch=${git.branch || "unknown"} port=${options.port} `
      + `account=${options.accountType}`,
  )
  return logger
}

export function printReadyBanner(serverUrl: string): void {
  consola.box(
    [
      `🌐 Settings:     ${serverUrl}/ui/settings/`,
      `📊 Usage:        ${serverUrl}/ui/settings/#usage`,
      ``,
      `Fast UI iteration: \`bun run app:ui\` rebuilds the UI on save`,
      `(reload the window to pick up changes).`,
    ].join("\n"),
  )
}
