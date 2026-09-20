export function resolveSidecarVersion(
  packageVersion: string,
  gitSha: string,
  explicitVersion?: string,
): string {
  if (explicitVersion) return explicitVersion
  return `${packageVersion}-dev+${gitSha.slice(0, 8) || "unknown"}`
}
