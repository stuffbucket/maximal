/**
 * Read and select profiles in Claude Desktop's config library
 * (`Claude-3p/configLibrary/`), independent of Maximal's own routing
 * ownership (`config.ts`).
 *
 * Claude publishes no schema for this layout. What is relied on, and where it
 * comes from (Claude Desktop 5.11492.5's own code, and Anthropic's
 * "Configuration implementation" page under
 * https://claude.com/docs/third-party/claude-desktop/):
 *
 *   configLibrary/_meta.json   { appliedId, entries: [{ id, name }], hybridPointer? }
 *   configLibrary/<id>.json    one profile per entry
 *
 * Desktop accepts an id only when it matches `/^[a-f0-9-]{36}$/`, applies a
 * selection by setting `appliedId` to an id already in `entries`, and
 * ignores `appliedId` while `hybridPointer` (an admin-console connection) is
 * present. Nothing else is assumed, so the index schema is deliberately loose
 * and a field a newer Desktop adds is preserved.
 *
 * Selecting writes `_meta.json` and nothing else: it never opens a profile
 * for writing, so keys Desktop sealed are never touched. Desktop reads the
 * library at launch, so a selection loads at its next launch.
 */

import fs from "node:fs"
import path from "node:path"
import { z } from "zod"

import {
  AtomicWriteConflictError,
  atomicWriteJson,
  readFileNoFollow,
} from "~/lib/platform/atomic-json"
import { parseJsonText } from "~/lib/platform/json-text"

/** Desktop's own pattern for a library id; it ignores any other. Ids become
 *  file names, so this also keeps them from addressing anything else. */
const PROFILE_ID = /^[a-f0-9-]{36}$/

const LABEL = "Claude Desktop config library index"

export type ProfileLibraryErrorCode =
  | "symlink"
  | "unreadable"
  | "malformed"
  | "no-index"
  | "hybrid-pointer"
  | "unsafe-id"
  | "unknown-profile"
  | "profile-unusable"
  | "conflict"
  | "write-failed"

export class ProfileLibraryError extends Error {
  readonly code: ProfileLibraryErrorCode

  constructor(code: ProfileLibraryErrorCode, message: string) {
    super(message)
    this.name = "ProfileLibraryError"
    this.code = code
  }
}

/** Loose on purpose: only the fields selection needs are checked. */
const IndexSchema = z.looseObject({
  appliedId: z.string(),
  entries: z.array(z.looseObject({ id: z.string(), name: z.string() })),
})

export type ProfileFileState = "ok" | "missing" | "unreadable" | "symlink"

export interface ProfileSummary {
  id: string
  name: string
  /** `_meta.json.appliedId` names this entry. */
  applied: boolean
  /** The id is safe to address and may be selected. */
  validId: boolean
  /** State of `<id>.json`; "unreadable" covers a non-object or bad JSON. */
  file: ProfileFileState
}

/** What the top-level `claude_desktop_config.json` says about
 *  `deploymentMode`. Claude opens in third-party mode, and so loads the
 *  applied profile, only for "3p"; the value itself is never reported. */
export type DeploymentModeState = "3p" | "unset" | "other" | "unreadable"

export interface ProfileLibraryView {
  dir: string
  deploymentMode: DeploymentModeState
  /** `_meta.json` exists. A fresh Desktop has no library yet. */
  indexPresent: boolean
  appliedId: string
  /** `appliedId` names an entry in the index. */
  appliedKnown: boolean
  /** An admin-console connection: Desktop ignores `appliedId` while set. */
  hybridPointer: boolean
  profiles: Array<ProfileSummary>
}

interface ParsedIndex {
  raw: string
  value: Record<string, unknown>
  appliedId: string
  entries: Array<{ id: string; name: string }>
}

function libraryDir(dir: string): string {
  return path.join(dir, "configLibrary")
}

function metaPath(dir: string): string {
  return path.join(libraryDir(dir), "_meta.json")
}

/** The library directory must be a real directory: a link there would aim
 *  every read and write somewhere else. Missing is not an error here. */
function checkLibraryDir(dir: string): boolean {
  let stat: fs.Stats
  try {
    stat = fs.lstatSync(libraryDir(dir))
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false
    }
    throw new ProfileLibraryError(
      "unreadable",
      "Claude Desktop's config library can't be read.",
    )
  }
  if (stat.isSymbolicLink()) {
    throw new ProfileLibraryError(
      "symlink",
      "Refusing to use Claude Desktop's config library: it is a symbolic link.",
    )
  }
  if (!stat.isDirectory()) {
    throw new ProfileLibraryError(
      "malformed",
      "Claude Desktop's config library is not a directory.",
    )
  }
  return true
}

/** Read a file with no link followed; null when absent. Never returns or
 *  logs content in an error. */
function readText(file: string, what: string): string | null {
  try {
    return readFileNoFollow(
      file,
      () =>
        new ProfileLibraryError(
          "symlink",
          `Refusing to read ${what}: it is a symbolic link.`,
        ),
    )
  } catch (error: unknown) {
    if (error instanceof ProfileLibraryError) throw error
    throw new ProfileLibraryError("unreadable", `Can't read ${what}.`)
  }
}

function readIndex(dir: string): ParsedIndex | null {
  if (!checkLibraryDir(dir)) return null
  const raw = readText(metaPath(dir), "the config library index (_meta.json)")
  if (raw === null) return null

  let json: unknown
  try {
    json = parseJsonText(raw)
  } catch {
    throw new ProfileLibraryError(
      "malformed",
      "The config library index (_meta.json) isn't valid JSON; left it untouched.",
    )
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    throw new ProfileLibraryError(
      "malformed",
      "The config library index (_meta.json) isn't a JSON object; left it untouched.",
    )
  }
  const parsed = IndexSchema.safeParse(json)
  if (!parsed.success) {
    // Paths only: an issue's received value could be anything in the file.
    const where = [
      ...new Set(parsed.error.issues.map((issue) => issue.path.join("."))),
    ].join(", ")
    throw new ProfileLibraryError(
      "malformed",
      `The config library index (_meta.json) has an unexpected shape (${where}); left it untouched.`,
    )
  }
  const ids = parsed.data.entries.map((entry) => entry.id)
  if (new Set(ids).size !== ids.length) {
    throw new ProfileLibraryError(
      "malformed",
      "The config library index (_meta.json) lists the same profile id twice; left it untouched.",
    )
  }
  return {
    raw,
    value: json as Record<string, unknown>,
    appliedId: parsed.data.appliedId,
    entries: parsed.data.entries.map(({ id, name }) => ({ id, name })),
  }
}

function profileFileState(dir: string, id: string): ProfileFileState {
  let text: string | null
  try {
    text = readText(path.join(libraryDir(dir), `${id}.json`), "a profile")
  } catch (error: unknown) {
    return error instanceof ProfileLibraryError && error.code === "symlink" ?
        "symlink"
      : "unreadable"
  }
  if (text === null) return "missing"
  try {
    const json = parseJsonText(text)
    return typeof json === "object" && json !== null && !Array.isArray(json) ?
        "ok"
      : "unreadable"
  } catch {
    return "unreadable"
  }
}

/** Read-only look at `<dir>/claude_desktop_config.json`. Anything that can't
 *  be read as a JSON object (including a symlink) is "unreadable": we can't
 *  confirm the mode, and nothing is written either way. */
function readDeploymentMode(dir: string): DeploymentModeState {
  let text: string | null
  try {
    text = readText(
      path.join(dir, "claude_desktop_config.json"),
      "claude_desktop_config.json",
    )
  } catch {
    return "unreadable"
  }
  if (text === null) return "unset"
  let json: unknown
  try {
    json = parseJsonText(text)
  } catch {
    return "unreadable"
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    return "unreadable"
  }
  const mode = (json as Record<string, unknown>).deploymentMode
  if (mode === undefined) return "unset"
  return mode === "3p" ? "3p" : "other"
}

function hasHybridPointer(index: ParsedIndex): boolean {
  return Object.hasOwn(index.value, "hybridPointer")
}

/** Read-only view of the library. A library that doesn't exist is an empty
 *  one; anything unreadable, malformed or linked throws. */
export function readProfileLibrary(dir: string): ProfileLibraryView {
  const index = readIndex(dir)
  if (!index) {
    return {
      dir,
      deploymentMode: readDeploymentMode(dir),
      indexPresent: false,
      appliedId: "",
      appliedKnown: false,
      hybridPointer: false,
      profiles: [],
    }
  }
  return {
    dir,
    deploymentMode: readDeploymentMode(dir),
    indexPresent: true,
    appliedId: index.appliedId,
    appliedKnown: index.entries.some((entry) => entry.id === index.appliedId),
    hybridPointer: hasHybridPointer(index),
    profiles: index.entries.map((entry) => {
      const validId = PROFILE_ID.test(entry.id)
      return {
        id: entry.id,
        name: entry.name,
        applied: entry.id === index.appliedId,
        validId,
        file: validId ? profileFileState(dir, entry.id) : "unreadable",
      }
    }),
  }
}

export interface ProfileSelectionPlan {
  dir: string
  id: string
  name: string
  /** Already selected: applying writes nothing. */
  unchanged: boolean
  previousAppliedId: string
  /** Read when planning; selecting never writes it. */
  deploymentMode: DeploymentModeState
  /** The exact `_meta.json` bytes this plan was made from; the write is
   *  refused if the file no longer holds them. */
  expectedContent: string
  next: Record<string, unknown>
}

/** Selecting a profile Desktop can't open would leave it on nothing. */
function requireUsableProfile(dir: string, id: string): void {
  const file = profileFileState(dir, id)
  if (file === "ok") return
  const why = {
    missing: "missing",
    symlink: "a symbolic link",
    unreadable: "unreadable",
  }[file]
  throw new ProfileLibraryError(
    "profile-unusable",
    `That profile's file is ${why}; not selecting it.`,
  )
}

/** Check that `id` can be selected and say what would change. Writes nothing. */
export function planProfileSelection(
  dir: string,
  id: string,
): ProfileSelectionPlan {
  if (!PROFILE_ID.test(id)) {
    throw new ProfileLibraryError(
      "unsafe-id",
      "That isn't a valid Claude Desktop profile id (expected 36 lowercase hex digits and dashes).",
    )
  }
  const index = readIndex(dir)
  if (!index) {
    throw new ProfileLibraryError(
      "no-index",
      "Claude Desktop has no config library here yet; nothing to select.",
    )
  }
  // Desktop ignores `appliedId` while an admin-console pointer is set, so a
  // write would claim a selection that never loads. Switching that is
  // Desktop's own action, not ours.
  if (hasHybridPointer(index)) {
    throw new ProfileLibraryError(
      "hybrid-pointer",
      "Claude Desktop is connected through an admin console (hybridPointer), which takes precedence over the selected profile; left it untouched. End that connection in Claude Desktop first.",
    )
  }
  const entry = index.entries.find((item) => item.id === id)
  if (!entry) {
    throw new ProfileLibraryError(
      "unknown-profile",
      "No profile with that id is in the config library index.",
    )
  }
  requireUsableProfile(dir, id)
  return {
    dir,
    id,
    name: entry.name,
    unchanged: index.appliedId === id,
    previousAppliedId: index.appliedId,
    deploymentMode: readDeploymentMode(dir),
    expectedContent: index.raw,
    // Spreading keeps every other field and the key order; only `appliedId`
    // changes.
    next: { ...index.value, appliedId: id },
  }
}

/** Write a plan: only `_meta.json`, only if its bytes are still the ones the
 *  plan was made from. Returns whether anything was written. */
export function applyProfileSelection(plan: ProfileSelectionPlan): boolean {
  if (plan.unchanged) return false
  // The plan can be old: the profile must still be there to load.
  requireUsableProfile(plan.dir, plan.id)
  try {
    atomicWriteJson(metaPath(plan.dir), plan.next, {
      label: LABEL,
      expectedContent: plan.expectedContent,
    })
  } catch (error: unknown) {
    if (
      error instanceof AtomicWriteConflictError
      || (error instanceof Error && /changed before/.test(error.message))
    ) {
      throw new ProfileLibraryError(
        "conflict",
        "The config library index changed while selecting; nothing was written. Re-run to select against its current state.",
      )
    }
    throw new ProfileLibraryError(
      "write-failed",
      error instanceof Error ? error.message : "Could not write the index.",
    )
  }
  return true
}
