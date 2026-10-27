/**
 * Where the MCP broker can run. On Windows the supervisor refuses to start
 * it (MCP_BROKER_CONTAINMENT_UNAVAILABLE: no kill-on-close Job Object yet),
 * so nothing should offer, turn on, or point client apps at an endpoint
 * there. Saved endpoints and client choices are kept for when it can.
 */
export function brokerRunsOn(
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform !== "win32"
}
