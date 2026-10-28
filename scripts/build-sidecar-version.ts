import { channelForTag } from "./write-updates-manifest"

export function resolveSidecarVersion(
  packageVersion: string,
  gitSha: string,
  explicitVersion?: string,
): string {
  if (explicitVersion) return explicitVersion
  return `${packageVersion}-dev+${gitSha.slice(0, 8) || "unknown"}`
}

/**
 * The release channel a sidecar build polls for updates. An explicit
 * MAXIMAL_CHANNEL wins. Otherwise a release version carries its channel in
 * its prerelease label (`0.5.0-rc.2` is `rc`), by the same rule the updates
 * manifest uses, so every producer stamps it, including the macOS builder,
 * which passes only MAXIMAL_VERSION. Local builds (no explicit version) are
 * stable.
 */
export function resolveSidecarChannel(
  explicitVersion?: string,
  explicitChannel?: string,
): string {
  if (explicitChannel) return explicitChannel
  if (!explicitVersion) return "stable"
  return channelForTag(`v${explicitVersion}`)
}
