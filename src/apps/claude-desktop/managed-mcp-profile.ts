import os from "node:os"
import { isDeepStrictEqual } from "node:util"

import { currentProfileId } from "~/apps/profile-identity"
import { readFileNoFollow } from "~/lib/platform/atomic-json"

import {
  atomicWriteJson,
  type GatewayProfileValues,
  gatewayProfile,
  getClaude3pDir,
  Library,
  markerEvidence,
  type RoutingState,
} from "./config"
import {
  type ClaudeDesktopManagedMcpServer,
  isMaximalDesktopManagedMcpServers,
} from "./managed-mcp"
import { fileFingerprint } from "./marker-evidence"

export type ClaudeDesktopManagedMcpUpdate = "written" | "removed" | null

interface OwnedProfile {
  lib: Library
  path: string
  raw: string
  value: Record<string, unknown>
  state: RoutingState
  markerCurrent: boolean
}

function ownedProfile(
  home: string,
  values: GatewayProfileValues,
): OwnedProfile | null {
  const lib = new Library(getClaude3pDir(home))
  if (lib.stateUnreadable) {
    throw new Error("Claude Desktop's routing state needs attention")
  }
  const entry = lib.meta.entries.find((item) => item.id === lib.meta.appliedId)
  if (!entry || lib.appliedOwnership(values) !== "ours") return null
  if (!lib.isUnedited(entry, values)) {
    throw new Error("Claude Desktop's applied profile changed unexpectedly")
  }
  const profilePath = lib.profilePath(entry.id)
  const raw = readFileNoFollow(
    profilePath,
    () => new Error("refusing to read Claude Desktop profile: symbolic link"),
  )
  const value = lib.profile(entry.id)
  if (!value || raw === null) {
    throw new Error("Claude Desktop's applied profile can't be read")
  }
  const state = lib.state
  if (
    !state
    || state.profileId !== entry.id
    || lib.routingStateOwnership() !== "ours"
  ) {
    throw new Error("Claude Desktop's routing marker changed unexpectedly")
  }
  const fingerprint = fileFingerprint(profilePath) ?? ""
  return {
    lib,
    path: profilePath,
    raw,
    value,
    state,
    markerCurrent: fingerprint === state.fingerprint,
  }
}

function writeProfile(
  profile: OwnedProfile,
  next: Record<string, unknown>,
  values: GatewayProfileValues,
): void {
  atomicWriteJson(profile.path, next, profile.raw)
  const { keyFingerprint: _staleKeyFingerprint, ...stateWithoutKey } =
    profile.state
  atomicWriteJson(
    profile.lib.statePath,
    {
      ...stateWithoutKey,
      version: 2,
      ownerProfileId: currentProfileId(),
      fingerprint: fileFingerprint(profile.path) ?? "",
      ...markerEvidence(values),
    },
    profile.lib.stateRaw,
  )
}

/** Replace Maximal's managed MCP array without claiming an edited profile. */
export function updateConfigLibraryManagedMcpServers(
  servers: ReadonlyArray<ClaudeDesktopManagedMcpServer>,
  home: string = os.homedir(),
  values: GatewayProfileValues = gatewayProfile(home),
): ClaudeDesktopManagedMcpUpdate {
  const wanted = [...servers]
  if (!isMaximalDesktopManagedMcpServers(wanted)) {
    throw new Error(
      "refusing to write an invalid Claude Desktop managed MCP set",
    )
  }

  const profile = ownedProfile(home, values)
  if (!profile) {
    if (wanted.length === 0) return null
    throw new Error("Claude Desktop's applied profile is not Maximal's")
  }
  const current = profile.value.managedMcpServers
  if (current !== undefined && !isMaximalDesktopManagedMcpServers(current)) {
    throw new Error("Claude Desktop's managed MCP servers were edited")
  }
  if (isDeepStrictEqual(current ?? [], wanted)) {
    if (!profile.markerCurrent) writeProfile(profile, profile.value, values)
    return null
  }

  const next = { ...profile.value }
  if (wanted.length === 0) Reflect.deleteProperty(next, "managedMcpServers")
  else next.managedMcpServers = wanted
  writeProfile(profile, next, values)
  return wanted.length === 0 ? "removed" : "written"
}
