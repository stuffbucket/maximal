/**
 * `maximal app claude-desktop --profiles | --current-profile |
 * --select-profile <id>`: the config-library profile surface (see
 * `profile-library.ts`). Kept apart from enable/disable on purpose: these
 * never touch Maximal's routing ownership, its marker, any profile file, or
 * `deploymentMode`.
 */

import type { ArgsDef } from "citty"

import consola from "consola"

import {
  applyProfileSelection,
  type DeploymentModeState,
  planProfileSelection,
  ProfileLibraryError,
  type ProfileLibraryView,
  type ProfileSummary,
  readProfileLibrary,
} from "./profile-library"

export const PROFILE_ARGS = {
  profiles: {
    type: "boolean",
    default: false,
    description:
      "List Claude Desktop's saved configuration profiles (read-only).",
  },
  "current-profile": {
    type: "boolean",
    default: false,
    description:
      "Show which saved profile Claude Desktop will load at its next launch (read-only).",
  },
  "select-profile": {
    type: "string",
    description:
      "Select a saved profile by id for Claude Desktop's next launch. Changes only _meta.json's appliedId; quit and relaunch Claude Desktop to load it.",
  },
} as const satisfies ArgsDef

const RESTART_NOTE =
  "Claude Desktop reads its profile at launch: quit and relaunch it. A running Claude keeps its current profile until then."

const PRECEDENCE_NOTE =
  "A managed (MDM) configuration, or an admin-console connection, takes precedence over the applied profile; Maximal can't see an MDM one."

/** Longest id or name shown, in characters. */
const MAX_SHOWN = 64

/** Text from a file Claude (or a person) wrote, made safe to print: control,
 *  format (bidi overrides, zero-width) and line-separator characters are
 *  dropped, so it can't forge output lines or hide text, and it is cut to
 *  `MAX_SHOWN` characters. */
function shown(value: string): string {
  const clean = value.replaceAll(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "")
  const chars = Array.from(clean)
  return chars.length > MAX_SHOWN ?
      `${chars.slice(0, MAX_SHOWN - 1).join("")}…`
    : clean
}

/** Does this invocation ask for a profile operation? */
export function profileCliRequested(args: Record<string, unknown>): boolean {
  return (
    args.profiles === true
    || args["current-profile"] === true
    || args["select-profile"] !== undefined
  )
}

function describe(profile: ProfileSummary): string {
  const flags = [
    profile.applied ? "applied" : null,
    profile.validId ? null : "invalid id",
    profile.file === "ok" ? null : `file ${profile.file}`,
  ].filter((flag) => flag !== null)
  return `${profile.applied ? "*" : " "} ${shown(profile.id)}\t${shown(profile.name)}${flags.length > 0 ? `\t(${flags.join(", ")})` : ""}`
}

function showHybridPointer(view: ProfileLibraryView): void {
  if (view.hybridPointer) {
    consola.warn(
      "Claude Desktop is connected through an admin console (hybridPointer); it takes precedence over the applied profile.",
    )
  }
}

const MODE_PROBLEMS: Record<Exclude<DeploymentModeState, "3p">, string> = {
  unset:
    "claude_desktop_config.json doesn't set deploymentMode to 3p (it is not set), so the applied profile will not be active on relaunch.",
  other:
    "claude_desktop_config.json doesn't set deploymentMode to 3p, so the applied profile will not be active on relaunch.",
  unreadable:
    "claude_desktop_config.json can't be read as JSON, so deploymentMode can't be confirmed as 3p; the applied profile may not be active on relaunch.",
}

/** Why the applied profile won't load at launch, or null when
 *  `deploymentMode` is "3p". */
function deploymentModeProblem(mode: DeploymentModeState): string | null {
  return mode === "3p" ? null : MODE_PROBLEMS[mode]
}

function showDeploymentMode(mode: DeploymentModeState): void {
  const problem = deploymentModeProblem(mode)
  if (problem) consola.warn(problem)
  else consola.info("  deploymentMode: 3p")
}

function listProfiles(dir: string): void {
  const view = readProfileLibrary(dir)
  if (!view.indexPresent || view.profiles.length === 0) {
    consola.info("Claude Desktop has no saved profiles here.")
    return
  }
  for (const profile of view.profiles) consola.info(describe(profile))
  if (!view.appliedKnown) {
    consola.warn(
      view.appliedId === "" ?
        "No profile is applied."
      : "The applied id doesn't match any profile listed.",
    )
  }
  showHybridPointer(view)
  showDeploymentMode(view.deploymentMode)
}

function showCurrent(dir: string): void {
  const view = readProfileLibrary(dir)
  const applied = view.profiles.find((profile) => profile.applied)
  if (applied) {
    consola.info(describe(applied))
  } else {
    consola.info(
      view.appliedId === "" ?
        "No profile is applied."
      : `The applied id (${shown(view.appliedId)}) doesn't match any profile listed.`,
    )
  }
  showHybridPointer(view)
  showDeploymentMode(view.deploymentMode)
  consola.info(
    "  Claude Desktop loads the applied profile at its next launch; a running Claude may still be on another profile.",
  )
}

/** What the selection means for Maximal's own routing. Maximal doesn't decide
 *  here whether a profile belongs to this copy, another copy or a person, so
 *  these say what can happen, not what will. */
function showRoutingNotes(name: string, routingIntended: boolean): void {
  if (routingIntended) {
    consola.warn(
      "Maximal's Claude Desktop routing is on for this copy. It re-applies its own profile when Maximal starts, after an API-key change, and when routing is enabled again in Settings; that switches back from a profile that isn't a gateway profile. Run `maximal app claude-desktop --disable` first to keep your selection.",
    )
    consola.warn(
      "Selecting a profile that another Maximal copy owns can turn this copy's routing intent off the next time it re-applies.",
    )
  } else if (name === "maximal") {
    consola.warn(
      "This is a Maximal entry and this copy's routing is off: its port or key may be stale, or Maximal may not be running, so Claude's requests can fail.",
    )
  }
}

function selectProfile(
  dir: string,
  id: string,
  routingIntended: boolean,
): void {
  const plan = planProfileSelection(dir, id)
  const label = `${shown(plan.id)} (${shown(plan.name) || "no name"})`
  if (plan.unchanged) {
    consola.success(
      `Profile ${label} is already the applied profile in the index; nothing written.`,
    )
  } else {
    applyProfileSelection(plan)
    consola.success(
      `Set appliedId to ${label} in the config library index. Nothing else was changed.`,
    )
  }
  const problem = deploymentModeProblem(plan.deploymentMode)
  if (problem) {
    // Selecting never writes deploymentMode: that is `--enable`'s job, or the
    // person's choice inside Claude.
    consola.warn(problem)
  } else {
    consola.info(`  deploymentMode is 3p. ${RESTART_NOTE}`)
  }
  consola.info(`  ${PRECEDENCE_NOTE}`)
  showRoutingNotes(plan.name, routingIntended)
}

/** Run the requested profile operation against Claude's `Claude-3p`
 *  directory. Returns the process exit code: a refusal prints why and is 1.
 *  `routingIntended` is whether Maximal's own Claude Desktop routing is on. */
export function runProfileCli(
  args: Record<string, unknown>,
  dir: string,
  routingIntended = false,
): number {
  const selectArg = args["select-profile"]
  const requested = [
    args.profiles === true,
    args["current-profile"] === true,
    selectArg !== undefined,
  ].filter(Boolean).length
  if (requested > 1) {
    consola.error(
      "Pass only one of --profiles, --current-profile and --select-profile.",
    )
    return 1
  }
  if (
    args.enable === true
    || args.disable === true
    || args.managed === true
    || args.force === true
  ) {
    consola.error(
      "Profile flags can't be combined with --enable, --disable, --managed or --force.",
    )
    return 1
  }
  try {
    if (selectArg !== undefined) {
      if (typeof selectArg !== "string" || selectArg === "") {
        consola.error("--select-profile needs a profile id.")
        return 1
      }
      selectProfile(dir, selectArg, routingIntended)
    } else if (args.profiles === true) {
      listProfiles(dir)
    } else {
      showCurrent(dir)
    }
    return 0
  } catch (error: unknown) {
    if (error instanceof ProfileLibraryError) {
      consola.error(error.message)
      return 1
    }
    throw error
  }
}
