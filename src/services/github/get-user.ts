import { getGitHubApiBaseUrl, githubUserHeaders } from "~/lib/api-config"
import { GITHUB_API_TIMEOUT_MS } from "~/lib/http-timeouts"
import { sendRequestJson } from "~/lib/send-request"
import { state } from "~/lib/state"

export async function getGitHubUser(githubToken?: string) {
  const resolvedGithubToken = githubToken ?? state.githubToken
  if (!resolvedGithubToken) {
    throw new Error("GitHub token not found")
  }

  return await sendRequestJson<GithubUserResponse>(
    `${getGitHubApiBaseUrl()}/user`,
    {
      credential: { domain: "github", token: resolvedGithubToken },
      headers: githubUserHeaders(),
      timeoutMs: GITHUB_API_TIMEOUT_MS,
      errorMessage: "Failed to get GitHub user",
    },
  )
}

// Trimmed for the sake of simplicity. `avatar_url` is the user's profile
// photo URL straight from the API — used for the Settings avatar. It works for
// Enterprise Managed Users (EMU, e.g. `name_org`), whose `github.com/<login>.png`
// has no public profile and 404s.
interface GithubUserResponse {
  login: string
  avatar_url?: string
}
