/**
 * The interface the proxy binds. Loopback unless `HOST` says otherwise: the
 * proxy answers every caller that can reach it, so listening on all
 * interfaces has to be a choice (`HOST=0.0.0.0`, or `::` for IPv6), never the
 * default. srvx reads `HOST` itself but falls back to Bun's `0.0.0.0`.
 */
export const DEFAULT_LISTEN_HOST = "127.0.0.1"

export function listenHostname(
  env: Record<string, string | undefined> = process.env,
): string {
  const host = env.HOST?.trim()
  return host || DEFAULT_LISTEN_HOST
}
