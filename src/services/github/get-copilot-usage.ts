import { getGitHubApiBaseUrl, githubHeaders } from "~/lib/api-config"
import { authFetchJson } from "~/lib/auth-fetch"
import { GITHUB_API_TIMEOUT_MS } from "~/lib/http-timeouts"
import { state } from "~/lib/state"

export const getCopilotUsage = async (
  githubToken?: string,
): Promise<CopilotUsageResponse> => {
  const resolvedGithubToken = githubToken ?? state.githubToken
  if (!resolvedGithubToken) {
    throw new Error("GitHub token not found")
  }

  const authState = { ...state, githubToken: resolvedGithubToken }
  return await authFetchJson<CopilotUsageResponse>(
    `${getGitHubApiBaseUrl()}/copilot_internal/user`,
    {
      headers: githubHeaders(authState),
      timeoutMs: GITHUB_API_TIMEOUT_MS,
      errorMessage: "Failed to get Copilot usage",
    },
  )
}

export interface QuotaDetail {
  entitlement: number
  overage_count: number
  overage_permitted: boolean
  percent_remaining: number
  quota_id: string
  quota_remaining: number
  remaining: number
  unlimited: boolean
}

interface QuotaSnapshots {
  chat: QuotaDetail
  completions: QuotaDetail
  premium_interactions: QuotaDetail
}

interface CopilotUsageResponse {
  login: string
  access_type_sku: string
  analytics_tracking_id: string
  assigned_date: string
  can_signup_for_limited: boolean
  chat_enabled: boolean
  copilot_plan?: string
  organization_login_list: Array<unknown>
  organization_list: Array<unknown>
  quota_reset_date: string
  quota_snapshots: QuotaSnapshots
  endpoints: {
    api: string
    telemetry: string
  }
}
