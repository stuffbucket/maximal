/**
 * `maximal app claude-desktop --profiles | --current-profile |
 * --select-profile <id>`: the config-library profile surface (see
 * `profile-library.ts`). Kept apart from enable/disable on purpose: these
 * never touch Maximal's routing ownership, its marker, or any profile file.
 */

import type { ArgsDef } from "citty"

import consola from "consola"

import {
  applyProfileSelection,
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
  "Claude Desktop reads its profile at launch: quit and relaunch it to load this one. A running Claude keeps its current profile until then."

const PRECEDENCE_NOTE =
  "A managed (MDM) configuration, or an admin-console connection, takes precedence over the selected profile."

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
  return `${profile.applied ? "*" : " "} ${profile.id}\t${profile.name}${flags.length > 0 ? `\t(${flags.join(", ")})` : ""}`
}

function showHybridPointer(view: ProfileLibraryView): void {
  if (view.hybridPointer) {
    consola.warn(
      "Claude Desktop is connected through an admin console (hybridPointer); it takes precedence over the applied profile.",
    )
  }
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
      : `The applied id (${view.appliedId}) doesn't match any profile listed.`,
    )
  }
  showHybridPointer(view)
  consola.info(
    "  This is what Claude Desktop loads at its next launch; a running Claude may still be on another profile.",
  )
}

function selectProfile(
  dir: string,
  id: string,
  routingIntended: boolean,
): void {
  const plan = planProfileSelection(dir, id)
  if (plan.unchanged) {
    consola.success(
      `Profile ${plan.id} (${plan.name}) is already selected; nothing written.`,
    )
    consola.info(`  ${RESTART_NOTE}`)
    return
  }
  applyProfileSelection(plan)
  consola.success(`Selected profile ${plan.id} (${plan.name}).`)
  consola.info(`  Only _meta.json's appliedId changed. ${RESTART_NOTE}`)
  consola.info(`  ${PRECEDENCE_NOTE}`)
  if (routingIntended) {
    consola.warn(
      "Maximal's Claude Desktop routing is on: when Maximal next starts it leaves another gateway profile selected, but re-applies its own profile over one that isn't a gateway. Run `maximal app claude-desktop --disable` first to keep that selection.",
    )
  }
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
