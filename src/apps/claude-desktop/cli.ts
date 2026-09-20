import consola from "consola"
import fs from "node:fs"
import path from "node:path"

import type { AppCli, AppCliOp } from "../index"

import { applyConfigLibraryProfile, generateManagedProfile } from "./config"
import { claudeAppInstalled, claudeAppCandidates } from "./detect"

const MANAGED_PROFILE_OUT = "maximal-claude-3p.mobileconfig"

/** Claude Desktop needs two flags beyond the shared status/enable/disable:
 *  `--force` (write even when the app isn't installed) and `--managed` (emit an
 *  MDM .mobileconfig instead of touching the config library). Enable and
 *  disable otherwise fall through to the generic framework (`ClientApp.enable`
 *  / `disable`), so this hook only intercepts the two extra behaviours. */
export const claudeDesktopCli: AppCli = {
  extraArgs: {
    force: {
      type: "boolean",
      default: false,
      description:
        "Enable even if /Applications/Claude.app is missing (write anyway).",
    },
    managed: {
      type: "boolean",
      default: false,
      description: `Emit a managed-preferences .mobileconfig (${MANAGED_PROFILE_OUT}) for MDM fleets instead of writing the config library.`,
    },
  },

  handle(op: AppCliOp, args: Record<string, unknown>): boolean {
    if (op !== "enable") return false

    if (args.managed === true) {
      writeManagedProfile()
      return true
    }

    if (!claudeAppInstalled() && args.force !== true) {
      const where = claudeAppCandidates().join(" or ") || "the usual location"
      consola.warn(
        `Claude Desktop not found (looked at ${where}). Install it from`
          + " https://claude.ai/download, then re-run. To write the config"
          + " anyway (e.g. before installing), pass --force.",
      )
      return true
    }

    apply()
    return true
  },
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
