/**
 * The host string for the current account, in gh's format (`github.com` or a
 * GHES domain). Used as the host part of the registry identity key
 * (`login@host`) so a maximal device-code account and the same gh-imported
 * account collapse to one entry.
 *
 * Deliberately a dependency-free leaf: deriving the host is just an env read,
 * and keeping it out of api-config means the token-store writers
 * (auth-controller, token.ts, start.ts) can import it without pulling in
 * api-config → state → get-models, which would close an import cycle back
 * through error → auth-controller.
 */

const normalizeDomain = (input: string): string =>
  input
    .trim()
    .replace(/^https?:\/\//u, "")
    .replace(/\/+$/u, "")

export const currentGitHubHost = (): string => {
  const raw = (process.env.COPILOT_API_ENTERPRISE_URL ?? "").trim()
  const domain = raw ? normalizeDomain(raw) : ""
  return domain || "github.com"
}
