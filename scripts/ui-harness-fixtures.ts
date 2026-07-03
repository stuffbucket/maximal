/**
 * UI-harness fixtures — one entry per SCENARIO. Each scenario is a complete,
 * contract-valid snapshot of every read endpoint, so switching scenarios in the
 * harness overlay reshapes the WHOLE UI at once (account state, apps, models,
 * keys, diagnostics).
 *
 * These are validated against the real Zod schemas in src/lib/settings-types.ts
 * at harness startup — if you add a field to a schema, the harness refuses to
 * boot until the fixtures match. That's the mechanism that keeps this honest.
 *
 * To add a state to observe: add a scenario here (or tweak an existing one).
 * No UI or server code changes needed.
 */
import type {
  AccountsListResponse,
  ApiKeysListResponse,
  AppsListResponse,
  AuthStatus,
  DiagnosticsResponse,
  ModelsListResponse,
  UpdateStatusResponse,
} from "../src/lib/settings-types"

// gh-status isn't a settings-types export (it's typed in shell/src/proxy/client.ts),
// so it's a plain shape here. installed:false hides the gh-reuse list.
interface GhStatusFixture {
  installed: boolean
  accounts: Array<{ login: string; host: string; active: boolean }>
}

export interface Scenario {
  label: string
  auth: AuthStatus
  /** What POST /auth/github/start transitions to (the pending code screen). */
  deviceCode?: AuthStatus
  apps: AppsListResponse
  apiKeys: ApiKeysListResponse
  accounts: AccountsListResponse
  models: ModelsListResponse
  diagnostics: DiagnosticsResponse
  updateStatus: UpdateStatusResponse
  ghStatus: GhStatusFixture
}

const ISO = (offsetMs = 0): string => new Date(1_750_000_000_000 + offsetMs).toISOString()

// ---- shared building blocks (overridden per scenario as needed) ------------
const baseModels: ModelsListResponse = {
  count: 3,
  loaded_at: ISO(),
  models: [
    {
      id: "claude-sonnet-4-5",
      name: "Claude Sonnet 4.5",
      vendor: "Anthropic",
      family: "claude",
      type: "chat",
      preview: false,
      context_window_tokens: 200_000,
      max_output_tokens: 8_192,
      capabilities: { vision: true, tool_calls: true, streaming: true, reasoning: true },
    },
    {
      id: "gpt-4o",
      name: "GPT-4o",
      vendor: "OpenAI",
      family: "gpt-4o",
      type: "chat",
      preview: false,
      context_window_tokens: 128_000,
      max_output_tokens: 4_096,
      capabilities: { vision: true, tool_calls: true, streaming: true, reasoning: false },
    },
    {
      id: "text-embedding-3-small",
      name: "Embedding 3 Small",
      vendor: "OpenAI",
      family: "embeddings",
      type: "embeddings",
      preview: true,
      context_window_tokens: null,
      max_output_tokens: null,
      capabilities: { vision: false, tool_calls: false, streaming: false, reasoning: false },
    },
  ],
}

const baseDiagnostics: DiagnosticsResponse = {
  version: "0.4.36",
  source_revision: "abc1234",
  source_branch: "main",
  launch_path: "/Applications/Maximal.app/Contents/MacOS/maximal",
  launch_kind: "dmg-app",
  pid: 4242,
  uptime_ms: 7_265_000,
  account_type: "individual",
  models_cached: 3,
  tokens: { github_token_present: true, copilot_token_present: true },
  rate_limit: {
    interval_seconds: null,
    wait_when_throttled: false,
    last_request_at: ISO(-60_000),
  },
  web_search: {
    kind: "CopilotResponsesExecutor",
    detail: "gpt-5-mini",
  },
}

const upToDate: UpdateStatusResponse = {
  current: "0.4.36",
  latest: "0.4.36",
  update_available: false,
  url: "https://mxml.sh/maximal/",
  enabled: true,
  checked_at: ISO(-30_000),
  last_error: null,
}

const appsAllInstalled: AppsListResponse = {
  apps: [
    {
      id: "claude-code",
      name: "Claude Code",
      kind: "config",
      enabled: true,
      status: "ready",
      installs: [{ path: "/Users/you/.local/bin/claude", version: "2.1.195", source: "local-bin" }],
      install: null,
      conflict: null,
    },
    {
      id: "claude-desktop",
      name: "Claude Desktop",
      kind: "config",
      enabled: false,
      status: "ready",
      installs: [],
      install: null,
      conflict: null,
    },
    {
      id: "copilot-cli",
      name: "Copilot CLI",
      kind: "coming-soon",
      enabled: false,
      status: "coming-soon",
      installs: [],
      install: null,
      conflict: null,
    },
  ],
}

const twoApiKeys: ApiKeysListResponse = {
  enforcing: true,
  entries: [
    { id: "key_1", label: "Laptop", key: "mxl_live_abcd1234efgh", enabled: true, created_at: ISO(-86_400_000) },
    { id: "key_2", label: "CI", key: "mxl_live_zzzz9999yyyy", enabled: false, created_at: ISO(-172_800_000) },
  ],
}

const twoAccounts: AccountsListResponse = {
  active_key: "octocat@github.com",
  accounts: [
    { key: "octocat@github.com", login: "octocat", host: "github.com", added_via: "device-code", obtained_at: ISO(-200_000), active: true },
    { key: "hubot@github.com", login: "hubot", host: "github.com", added_via: "gh-cli", obtained_at: ISO(-400_000), active: false },
  ],
}

const ghAvailable: GhStatusFixture = {
  installed: true,
  accounts: [
    { login: "octocat", host: "github.com", active: true },
    { login: "monalisa", host: "github.com", active: false },
  ],
}

// ---- the scenarios ---------------------------------------------------------
export const SCENARIOS = {
  "signed-in": {
    label: "Signed in · healthy",
    auth: {
      state: "authenticated",
      account_login: "octocat",
      account_avatar_url: "https://github.com/octocat.png?size=128",
      connected_since: ISO(-7_265_000),
    },
    apps: appsAllInstalled,
    apiKeys: twoApiKeys,
    accounts: twoAccounts,
    models: baseModels,
    diagnostics: baseDiagnostics,
    updateStatus: upToDate,
    ghStatus: ghAvailable,
  },

  "signed-out": {
    label: "Signed out · gh accounts available",
    auth: { state: "unauthenticated" },
    deviceCode: {
      state: "device_code_issued",
      user_code: "WXYZ-1234",
      verification_uri: "https://github.com/login/device",
      expires_at: ISO(900_000),
    },
    apps: appsAllInstalled,
    apiKeys: { enforcing: false, entries: [] },
    accounts: { active_key: null, accounts: [] },
    models: { count: 0, loaded_at: null, models: [] },
    diagnostics: { ...baseDiagnostics, tokens: { github_token_present: false, copilot_token_present: false }, account_type: "unknown", models_cached: 0 },
    updateStatus: upToDate,
    ghStatus: ghAvailable,
  },

  "claude-code-missing": {
    label: "Apps · Claude Code not installed (install offer)",
    auth: {
      state: "authenticated",
      account_login: "octocat",
      connected_since: ISO(-7_265_000),
    },
    apps: {
      apps: appsAllInstalled.apps.map((a) =>
        a.id === "claude-code" ?
          { ...a, enabled: false, status: "not-installed" as const, installs: [], install: { method: "curl", command: "curl -fsSL https://claude.ai/install.sh | sh" } }
        : a,
      ),
    },
    apiKeys: twoApiKeys,
    accounts: twoAccounts,
    models: baseModels,
    diagnostics: baseDiagnostics,
    updateStatus: upToDate,
    ghStatus: ghAvailable,
  },

  "apps-conflict": {
    label: "Apps · Claude Code base-URL conflict",
    auth: {
      state: "authenticated",
      account_login: "octocat",
      connected_since: ISO(-7_265_000),
    },
    apps: {
      apps: appsAllInstalled.apps.map((a) =>
        a.id === "claude-code" ? { ...a, enabled: false, conflict: "foreign-base-url" as const } : a,
      ),
    },
    apiKeys: twoApiKeys,
    accounts: twoAccounts,
    models: baseModels,
    diagnostics: baseDiagnostics,
    updateStatus: upToDate,
    ghStatus: ghAvailable,
  },

  "upstream-rejection": {
    label: "Account · upstream rejection banner (429)",
    auth: {
      state: "authenticated",
      account_login: "octocat",
      connected_since: ISO(-7_265_000),
      last_upstream_rejection: {
        message: "You have exceeded your Copilot usage limit.",
        status: 429,
        at: ISO(-5_000),
        remediation_url: "https://github.com/settings/copilot",
      },
    },
    apps: appsAllInstalled,
    apiKeys: twoApiKeys,
    accounts: twoAccounts,
    models: baseModels,
    diagnostics: baseDiagnostics,
    updateStatus: upToDate,
    ghStatus: ghAvailable,
  },

  "auth-error": {
    label: "Account · sign-in error + remediation",
    auth: {
      state: "error",
      error: "GitHub rejected the device code (expired). Try again.",
      remediation_url: "https://github.com/login/device",
    },
    apps: appsAllInstalled,
    apiKeys: twoApiKeys,
    accounts: twoAccounts,
    models: baseModels,
    diagnostics: baseDiagnostics,
    updateStatus: upToDate,
    ghStatus: ghAvailable,
  },

  "update-available": {
    label: "Diagnostics · update available",
    auth: {
      state: "authenticated",
      account_login: "octocat",
      connected_since: ISO(-7_265_000),
    },
    apps: appsAllInstalled,
    apiKeys: twoApiKeys,
    accounts: twoAccounts,
    models: baseModels,
    diagnostics: baseDiagnostics,
    updateStatus: {
      current: "0.4.36",
      latest: "0.4.40",
      update_available: true,
      url: "https://mxml.sh/maximal/",
      enabled: true,
      checked_at: ISO(-30_000),
      last_error: null,
    },
    ghStatus: ghAvailable,
  },
} satisfies Record<string, Scenario>

export type ScenarioId = keyof typeof SCENARIOS
export const defaultScenarioId: ScenarioId = "signed-in"
