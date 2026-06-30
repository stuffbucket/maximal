import { defineCommand } from "citty"
import consola from "consola"
import fs from "node:fs"
import path from "node:path"

import {
  applyConfigLibraryProfile,
  generateManagedProfile,
  revertConfigLibraryProfile,
} from "./config"
import { claudeAppInstalled, claudeAppCandidates } from "./detect"

const MANAGED_PROFILE_OUT = "maximal-claude-3p.mobileconfig"

interface ConfigureOptions {
  force: boolean
  revert: boolean
  managed: boolean
}

export function runConfigureClaudeDesktop(opts: ConfigureOptions): void {
  consola.box(
    opts.revert ?
      "maximal configure-claude-desktop --revert"
    : "maximal configure-claude-desktop",
  )

  if (opts.revert) {
    revert()
    return
  }

  if (opts.managed) {
    writeManagedProfile()
    return
  }

  if (!claudeAppInstalled() && !opts.force) {
    const where = claudeAppCandidates().join(" or ") || "the usual location"
    consola.warn(
      `Claude Desktop not found (looked at ${where}). Install it from`
        + " https://claude.ai/download, then re-run this command. To"
        + " write the config anyway (e.g. before installing), pass --force.",
    )
    return
  }

  apply()
}

function apply(): void {
  try {
    const result = applyConfigLibraryProfile()
    if (result.wrote) {
      consola.success(
        `Claude Desktop wired at the gateway (${result.dir}, profile ${result.profileId})`,
      )
    } else {
      consola.success("Claude Desktop already configured")
    }
    if (result.ensuredWorkspaceFolders.length > 0) {
      consola.info(
        `  workspace folders: ${result.ensuredWorkspaceFolders.join(", ")}`,
      )
    }
    consola.info(
      "  Quit & relaunch Claude Desktop for the change to take effect.",
    )
  } catch (err) {
    consola.error("Could not update Claude Desktop config", err)
  }
}

function revert(): void {
  try {
    const result = revertConfigLibraryProfile()
    if (result.reverted) {
      consola.success(`Removed our gateway profile from ${result.dir}`)
    } else {
      consola.info("Claude Desktop wasn't wired by us; nothing to do")
    }
  } catch (err) {
    consola.error("Could not revert Claude Desktop config", err)
  }
}

function writeManagedProfile(): void {
  try {
    fs.writeFileSync(MANAGED_PROFILE_OUT, generateManagedProfile(), {
      mode: 0o600,
    })
    const abs = path.resolve(MANAGED_PROFILE_OUT)
    consola.success(`Wrote managed-preferences profile to ${abs}`)
    consola.info(
      "  Install it (no Anthropic sign-in needed) via either:\n"
        + `    sudo profiles install -path ${abs}\n`
        + "  …or push it through your MDM (Intune/Jamf). It is read\n"
        + "  regardless of Claude Desktop's data dir and outranks file config.",
    )
  } catch (err) {
    consola.error("Could not write managed profile", err)
  }
}

export const configureClaudeDesktop = defineCommand({
  meta: {
    name: "configure-claude-desktop",
    description:
      "Wire Claude Desktop (Cowork 3P) at the local proxy (opt-in; setup does not configure it).",
  },
  args: {
    force: {
      type: "boolean",
      default: false,
      description:
        "Write the config even if /Applications/Claude.app is missing.",
    },
    revert: {
      type: "boolean",
      default: false,
      description: "Remove the gateway profile this command writes.",
    },
    managed: {
      type: "boolean",
      default: false,
      description: `Emit a managed-preferences .mobileconfig (${MANAGED_PROFILE_OUT}) for MDM fleets instead of writing the config library.`,
    },
  },
  run({ args }) {
    runConfigureClaudeDesktop({
      force: args.force,
      revert: args.revert,
      managed: args.managed,
    })
  },
})
