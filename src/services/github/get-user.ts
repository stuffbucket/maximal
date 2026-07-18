import { z } from "zod"

import { getGitHubApiBaseUrl, githubUserHeaders } from "~/lib/config/api-config"
import { GITHUB_API_TIMEOUT_MS } from "~/lib/http/http-timeouts"
import { sendRequestJson } from "~/lib/http/send-request"
import { state } from "~/lib/runtime-state/state"

export async function getGitHubUser(githubToken?: string) {
  const resolvedGithubToken = githubToken ?? state.githubToken
  if (!resolvedGithubToken) {
    throw new Error("GitHub token not found")
  }

  return await sendRequestJson(
    `${getGitHubApiBaseUrl()}/user`,
    {
      githubToken: resolvedGithubToken,
      headers: githubUserHeaders(),
      timeoutMs: GITHUB_API_TIMEOUT_MS,
      errorMessage: "Failed to get GitHub user",
    },
    GithubUserResponseSchema,
  )
}

// Trimmed to the two fields the UI reads; everything else the API returns is
// passed through. `login` is required — a user response without it can't key an
// account, so failing loudly beats persisting `unknown@github.com`. `avatar_url`
// is the profile photo (Settings avatar); optional because Enterprise Managed
// Users (EMU, e.g. `name_org`) have no public `github.com/<login>.png`.
const GithubUserResponseSchema = z
  .object({
    login: z.string(),
    avatar_url: z.string().optional(),
  })
  .loose()
