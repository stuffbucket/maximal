/**
 * Which Maximal this is, as far as FigJam needs to know: the production app,
 * one development profile (`bun run app:dev` gives every worktree its own,
 * with its own data directory and Maximal port), or neither (`bun run dev`,
 * tests). The profile names the Figma development plugin so profiles never
 * share a plugin id (and so never share its `clientStorage`: panel settings,
 * pairing tokens), and it tells the plugin how chatty its logs may be.
 *
 * The shell sets `MAXIMAL_INSTANCE_ID` to the app identifier and the plugin
 * runner inherits it, so the same answer comes out in the serving process
 * (the discovery route) and in the plugin's process.
 */
import { createHash } from "node:crypto"

/** The app identifier of the released app. */
export const PRODUCTION_INSTANCE_ID = "co.stuffbucket.maximal"

export type ProfileKind = "production" | "development" | "local"

export interface FigjamProfile {
  kind: ProfileKind
  /**
   * `production` and `local` for those kinds; a development profile's own id
   * (`a-z0-9`, up to 40) otherwise. Safe to show and to put in a plugin id.
   */
  id: string
}

const DEV_PROFILE = /\.maximal-([a-f0-9]{12})$/

export function resolveProfile(
  env: Readonly<Record<string, string | undefined>> = process.env,
): FigjamProfile {
  const instance = env.MAXIMAL_INSTANCE_ID?.trim()
  if (!instance) return { kind: "local", id: "local" }
  if (instance === PRODUCTION_INSTANCE_ID) {
    return { kind: "production", id: "production" }
  }
  const worktree = DEV_PROFILE.exec(instance)?.[1]
  const id =
    worktree ?? createHash("sha256").update(instance).digest("hex").slice(0, 12)
  return { kind: "development", id }
}

/**
 * The id that makes the built Figma plugin profile-specific: a development
 * profile's id, or `undefined` for the shared plugin (production and local
 * runs keep the one "Maximal Agent (dev)" import they have always had).
 */
export function pluginProfileId(profile: FigjamProfile): string | undefined {
  return profile.kind === "development" ? profile.id : undefined
}

/** Whether development-level logging is welcome (anything but production). */
export function isVerbose(profile: FigjamProfile): boolean {
  return profile.kind !== "production"
}
