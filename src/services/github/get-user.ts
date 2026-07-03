import { getGitHubApiBaseUrl, githubUserHeaders } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { GITHUB_API_TIMEOUT_MS } from "~/lib/http-timeouts"
import { state } from "~/lib/state"

export async function getGitHubUser(githubToken?: string) {
  const resolvedGithubToken = githubToken ?? state.githubToken
  if (!resolvedGithubToken) {
    throw new Error("GitHub token not found")
  }

  const authState = { ...state, githubToken: resolvedGithubToken }
  const response = await fetch(`${getGitHubApiBaseUrl()}/user`, {
    // codeql[js/file-access-to-http] -- by design: the proxy reads its own 0o600 GitHub token from disk and forwards it as upstream Authorization. Same posture as gh/aws/kubectl; this is the proxy's reason to exist. See ADR-0001.
    headers: githubUserHeaders(authState),
    signal: AbortSignal.timeout(GITHUB_API_TIMEOUT_MS),
  })

  if (!response.ok) throw new HTTPError("Failed to get GitHub user", response)

  return (await response.json()) as GithubUserResponse
}

// Trimmed for the sake of simplicity. `avatar_url` is the user's profile
// photo URL straight from the API — used for the Settings avatar. It works for
// Enterprise Managed Users (EMU, e.g. `name_org`), whose `github.com/<login>.png`
// has no public profile and 404s.
interface GithubUserResponse {
  login: string
  avatar_url?: string
}
