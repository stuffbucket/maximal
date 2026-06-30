import { defineCommand } from "citty"
import consola from "consola"

import {
  applyProxyBaseUrl,
  getClaudeCodeSettingsPath,
  revertProxyBaseUrl,
} from "./config"

interface ConfigureOptions {
  revert: boolean
  filePath?: string
}

export function runConfigureClaudeCode(opts: ConfigureOptions): void {
  const filePath = opts.filePath ?? getClaudeCodeSettingsPath()
  consola.box(
    opts.revert ?
      "maximal configure-claude-code --revert"
    : "maximal configure-claude-code",
  )

  if (opts.revert) {
    revert(filePath)
    return
  }
  apply(filePath)
}

function apply(filePath: string): void {
  try {
    const result = applyProxyBaseUrl(filePath)
    if (result.wrote) {
      consola.success(`Pointed Claude Code at the proxy (${result.path})`)
    } else if (result.skippedReason === "foreign-base-url") {
      consola.warn(
        `A non-proxy ANTHROPIC_BASE_URL is already set in ${result.path};`
          + " left it untouched. Remove it first if you want proxy routing.",
      )
    } else {
      consola.success("Claude Code already points at the proxy")
    }
  } catch (err) {
    consola.error("Could not update Claude Code settings", err)
  }
}

function revert(filePath: string): void {
  try {
    const result = revertProxyBaseUrl(filePath)
    if (result.wrote) {
      consola.success(`Removed the proxy base URL from ${result.path}`)
    } else {
      consola.info(
        "Claude Code didn't have our base URL set; nothing to revert",
      )
    }
  } catch (err) {
    consola.error("Could not revert Claude Code settings", err)
  }
}

export const configureClaudeCode = defineCommand({
  meta: {
    name: "configure-claude-code",
    description:
      "Point Claude Code at the local proxy via ~/.claude/settings.json"
      + " (opt-in; --revert to remove).",
  },
  args: {
    revert: {
      type: "boolean",
      default: false,
      description:
        "Remove the ANTHROPIC_BASE_URL this command writes, leaving other"
        + " settings intact.",
    },
  },
  run({ args }) {
    runConfigureClaudeCode({ revert: args.revert })
  },
})
