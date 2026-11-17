/**
 * Which Maximal this is, for the parent-owned FigJam routes. The FigJam
 * plugin works out the same answer inside its own process
 * (`packages/plugin-figjam/src/profile.ts`, which names the Figma plugin by
 * it); `tests/figjam-route.test.ts` pins that the two agree. Only the
 * composition root may import plugin packages, so the small rule is repeated
 * here instead of shared.
 *
 * The shell sets `MAXIMAL_INSTANCE_ID` to the app identifier; production is
 * `co.stuffbucket.maximal`, an `app:dev` worktree profile is
 * `co.stuffbucket.maximal.dev.maximal-<12 hex>`, and a run with neither
 * (`bun run dev`, tests) is "local".
 */
import { createHash } from "node:crypto"

const PRODUCTION_INSTANCE_ID = "co.stuffbucket.maximal"
const DEV_PROFILE = /\.maximal-([a-f0-9]{12})$/

export interface FigjamProfile {
  kind: "production" | "development" | "local"
  id: string
}

export function resolveFigjamProfile(
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

/** Whether development-level logging is welcome (anything but production). */
export function isVerboseProfile(profile: FigjamProfile): boolean {
  return profile.kind !== "production"
}
