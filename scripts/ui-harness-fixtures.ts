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
  McpEndpointsListResponse,
  ModelsListResponse,
  PendingRequestsResponse,
  UpdateStatusResponse,
} from "../src/lib/config/settings-types"

// gh-status isn't a settings-types export (it's typed in shell/src/proxy/client.ts),
// so it's a plain shape here. installed:false hides the gh-reuse list.
interface GhStatusFixture {
  installed: boolean
  accounts: Array<{ login: string; host: string; active: boolean }>
}

// Active clients and the dashboard's /usage + /token-usage payloads have no
// Zod schema either (typed in shell/src/proxy/client.ts and
// shell/src/dashboard/main.ts), so they're plain shapes mirrored by name.
interface ActiveClientsFixture {
  clients: Array<{ key: string; label: string; userAgent: string; ageSeconds: number }>
  total: number
}

interface QuotaFixture {
  entitlement: number
  remaining: number
  percent_remaining: number
  unlimited: boolean
}

interface TokenTotalsFixture {
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
  input_tokens: number
  output_tokens: number
  request_count: number
  total_tokens: number
  total_nano_aiu: number
}

interface TokenEventFixture {
  created_at_utc: string
  created_at_ms: number
  user_id: string | null
  session_id: string | null
  trace_id: string | null
  endpoint: string
  model: string
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
  total_tokens: number
}

export interface DashboardFixture {
  usage: { quota_snapshots?: Record<string, QuotaFixture> | null; quota_reset_date?: string }
  tokenUsage: {
    totals?: TokenTotalsFixture
    range?: { start_ms: number; end_ms: number }
    byModel: Array<TokenTotalsFixture & { model: string }>
    /** Last 15 minutes, oldest first (the Dashboard's rate meter). */
    recent_minutes?: Array<{ start_ms: number; total_tokens: number }>
  }
  /** Every event in the period; the mock pages through it. */
  tokenEvents: Array<TokenEventFixture>
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
  /** Optional on each scenario; `resolveScenario` fills the shared default. */
  mcp?: McpEndpointsListResponse
  /** MCP servers' requests waiting for an answer (Settings → Requests). */
  requests?: PendingRequestsResponse
  clients?: ActiveClientsFixture
  dashboard?: DashboardFixture
}

export type ResolvedScenario = Required<Omit<Scenario, "deviceCode">> &
  Pick<Scenario, "deviceCode">


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
  context_management: {
    advertised: [
      { model: "claude-sonnet-4-5", support: true },
      { model: "gpt-4o", support: false },
    ],
    cache: {
      policy: "rejections-only",
      entries: [{ model: "gpt-4o", strategy: "clear_tool_uses", rejected_at: ISO(-3_600_000) }],
    },
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
      id: "codex",
      name: "Codex",
      kind: "config",
      enabled: true,
      status: "ready",
      installs: [
        {
          kind: "cli",
          path: "/Users/you/.local/bin/codex",
          version: null,
          source: "local-bin",
        },
        {
          kind: "desktop",
          path: "/Applications/Codex.app",
          version: null,
          source: "unknown",
        },
      ],
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

const workiqFound: McpEndpointsListResponse["available"][number] = {
  id: "workiq",
  label: "Work IQ",
  status: "ready",
  command:
    "/Users/alex/.local/share/mise/installs/npm-microsoft-workiq/1.0.1/node_modules/@microsoft/workiq/bin/osx-arm64/workiq",
  version: "1.0.1",
  install: {
    command: "npm install -g @microsoft/workiq",
    url: "https://www.npmjs.com/package/@microsoft/workiq",
  },
}

const twoMcpEndpoints: McpEndpointsListResponse = {
  broker: { state: "running", problem: null },
  available: [],
  endpoints: [
    {
      id: "workiq",
      label: "Work IQ",
      enabled: true,
      clients: ["claude-code"],
      offered: [
        { id: "claude-code", name: "Claude Code", available: true, configured: true },
        { id: "claude-desktop", name: "Claude Desktop", available: false, configured: false },
      ],
    },
    {
      id: "github",
      label: "GitHub",
      enabled: false,
      clients: [],
      offered: [
        { id: "claude-code", name: "Claude Code", available: true, configured: false },
        { id: "claude-desktop", name: "Claude Desktop", available: false, configured: false },
      ],
    },
  ],
}

const recentClients: ActiveClientsFixture = {
  clients: [
    { key: "key_1", label: "Laptop", userAgent: "claude-cli/2.1.195 (external, cli)", ageSeconds: 12 },
    { key: "unlabeled", label: "", userAgent: "OpenAI/Python 1.99.0", ageSeconds: 340 },
  ],
  total: 2,
}

const ZERO_TOTALS: TokenTotalsFixture = {
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  input_tokens: 0,
  output_tokens: 0,
  request_count: 0,
  total_tokens: 0,
  total_nano_aiu: 0,
}

function tokenEvents(count: number): Array<TokenEventFixture> {
  const models = ["claude-sonnet-4-5", "gpt-4o", "claude-sonnet-4-5", "gpt-5-mini"]
  const endpoints = ["/v1/messages", "/v1/chat/completions", "/v1/messages", "/v1/responses"]
  return Array.from({ length: count }, (_, i) => {
    const ms = 1_750_000_000_000 - i * 97_000
    const input = 1_200 + ((i * 7_919) % 18_000)
    const output = 80 + ((i * 3_571) % 2_400)
    const cacheRead = i % 3 === 0 ? 0 : (i * 1_237) % 40_000
    return {
      created_at_utc: new Date(ms).toISOString(),
      created_at_ms: ms,
      user_id: null,
      session_id: `sess_${Math.floor(i / 6)}`,
      trace_id: null,
      endpoint: endpoints[i % endpoints.length],
      model: models[i % models.length],
      input_tokens: input,
      output_tokens: output,
      cache_read_input_tokens: cacheRead,
      cache_creation_input_tokens: 0,
      total_tokens: input + output + cacheRead,
    }
  })
}

function summarize(events: Array<TokenEventFixture>): DashboardFixture["tokenUsage"] {
  const byModel = new Map<string, TokenTotalsFixture & { model: string }>()
  const totals = { ...ZERO_TOTALS }
  for (const e of events) {
    const row = byModel.get(e.model) ?? { model: e.model, ...ZERO_TOTALS }
    for (const t of [row, totals]) {
      t.input_tokens += e.input_tokens
      t.output_tokens += e.output_tokens
      t.cache_read_input_tokens += e.cache_read_input_tokens
      t.cache_creation_input_tokens += e.cache_creation_input_tokens
      t.total_tokens += e.total_tokens
      t.request_count += 1
      t.total_nano_aiu += e.total_tokens * 1_000
    }
    byModel.set(e.model, row)
  }
  return {
    totals,
    range: { start_ms: 1_750_000_000_000 - 86_400_000, end_ms: 1_750_000_000_000 },
    byModel: [...byModel.values()].sort((a, b) => b.total_tokens - a.total_tokens),
  }
}

/** GitHub's quota_reset_date shape ("YYYY-MM-DD"), relative to now so the
 *  fixture never ages into "period ended": the 1st of next month. */
function nextResetDate(): string {
  const now = new Date()
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString().slice(0, 10)
}

/** 15 per-minute buckets ending at the current minute, from `values`. */
function recentMinutes(values: Array<number>): Array<{ start_ms: number; total_tokens: number }> {
  const current = Math.floor(Date.now() / 60_000) * 60_000
  return values.map((total_tokens, i) => ({
    start_ms: current - (values.length - 1 - i) * 60_000,
    total_tokens,
  }))
}

const busyDayEvents = tokenEvents(47)
const busyDashboard: DashboardFixture = {
  usage: {
    quota_snapshots: {
      chat: { entitlement: 0, remaining: 0, percent_remaining: 100, unlimited: true },
      completions: { entitlement: 0, remaining: 0, percent_remaining: 100, unlimited: true },
      premium_interactions: { entitlement: 300, remaining: 112, percent_remaining: 37.3, unlimited: false },
    },
    quota_reset_date: nextResetDate(),
  },
  tokenUsage: {
    ...summarize(busyDayEvents),
    // A quiet stretch, then a working session picking up.
    recent_minutes: recentMinutes([0, 0, 1200, 0, 0, 3400, 8100, 5200, 0, 2600, 9800, 14200, 11800, 16500, 7400]),
  },
  tokenEvents: busyDayEvents,
}

const emptyDashboard: DashboardFixture = {
  usage: { quota_snapshots: null },
  tokenUsage: { totals: ZERO_TOTALS, byModel: [], recent_minutes: recentMinutes(Array(15).fill(0)) },
  tokenEvents: [],
}

/** A signed-in, everything-normal scenario to vary one surface from. */
function healthy(label: string): Scenario {
  return {
    label,
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
    updateStatus: upToDate,
    ghStatus: ghAvailable,
  }
}

// ---- the scenarios ---------------------------------------------------------
// Relative to now (not ISO()), so "time left" reads naturally in the harness.
const inMinutes = (minutes: number): string =>
  new Date(Date.now() + minutes * 60_000).toISOString()

const waitingRequests: PendingRequestsResponse = {
  requests: [
    {
      id: "elicit-form",
      endpointId: "workiq",
      label: "Work IQ",
      toolName: "get_debug_link",
      mode: "form",
      message:
        "Create a shareable debug link for this conversation? Anyone with the link can see the conversation's diagnostic details for 7 days.",
      fields: [
        { name: "confirmed", kind: "boolean", title: "Create the link", required: true },
        {
          name: "audience",
          kind: "enum",
          title: "Who can open it",
          required: true,
          options: [
            { value: "org", label: "People in my organization" },
            { value: "me", label: "Only me" },
          ],
        },
        { name: "note", kind: "string", title: "Note for support", required: false, maxLength: 200 },
      ],
      receivedAt: inMinutes(-1),
      expiresAt: inMinutes(4),
    },
    {
      id: "elicit-url",
      endpointId: "workiq",
      label: "Work IQ",
      mode: "url",
      message: "Sign in to Microsoft 365 to let Work IQ read your calendar.",
      fields: [],
      url: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=example",
      urlHost: "login.microsoftonline.com",
      receivedAt: inMinutes(0),
      expiresAt: inMinutes(5),
    },
  ],
}

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

  "codex-missing": {
    label: "Apps · Codex not installed",
    auth: {
      state: "authenticated",
      account_login: "octocat",
      connected_since: ISO(-7_265_000),
    },
    apps: {
      apps: appsAllInstalled.apps.map((app) =>
        app.id === "codex" ?
          {
            ...app,
            enabled: false,
            status: "not-installed" as const,
            installs: [],
          }
        : app,
      ),
    },
    apiKeys: twoApiKeys,
    accounts: twoAccounts,
    models: baseModels,
    diagnostics: baseDiagnostics,
    updateStatus: upToDate,
    ghStatus: ghAvailable,
  },

  "codex-cleanup-required": {
    label: "Apps · Codex cleanup required",
    auth: {
      state: "authenticated",
      account_login: "octocat",
      connected_since: ISO(-7_265_000),
    },
    apps: {
      apps: appsAllInstalled.apps.map((app) =>
        app.id === "codex" ?
          {
            ...app,
            enabled: false,
            conflict: "cleanup-required" as const,
          }
        : app,
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

  "sign-in-pending": {
    label: "Account · device code issued (waiting for GitHub)",
    auth: {
      state: "device_code_issued",
      user_code: "WXYZ-1234",
      verification_uri: "https://github.com/login/device",
      expires_at: ISO(900_000),
    },
    apps: appsAllInstalled,
    apiKeys: { enforcing: false, entries: [] },
    accounts: { active_key: null, accounts: [] },
    models: { count: 0, loaded_at: null, models: [] },
    diagnostics: baseDiagnostics,
    updateStatus: upToDate,
    ghStatus: { installed: false, accounts: [] },
  },

  "fresh-install": {
    label: "Fresh install · nothing configured, no usage yet",
    auth: {
      state: "authenticated",
      account_login: "octocat",
      connected_since: ISO(-20_000),
    },
    apps: {
      apps: appsAllInstalled.apps.map((a) => (a.kind === "config" ? { ...a, enabled: false } : a)),
    },
    apiKeys: { enforcing: false, entries: [] },
    accounts: twoAccounts,
    models: baseModels,
    diagnostics: baseDiagnostics,
    updateStatus: upToDate,
    ghStatus: ghAvailable,
    mcp: { endpoints: [], broker: { state: "off", problem: null }, available: [] },
    clients: { clients: [], total: 0 },
    dashboard: emptyDashboard,
  },

  "quota-nearly-out": {
    ...healthy("Dashboard · premium quota nearly used up"),
    dashboard: {
      ...busyDashboard,
      usage: {
        quota_snapshots: {
          chat: { entitlement: 0, remaining: 0, percent_remaining: 100, unlimited: true },
          premium_interactions: { entitlement: 300, remaining: 14, percent_remaining: 4.7, unlimited: false },
          code_review: { entitlement: 50, remaining: 11, percent_remaining: 22, unlimited: false },
        },
        quota_reset_date: nextResetDate(),
      },
    },
  },

  "quota-period-ended": {
    ...healthy("Dashboard · quota numbers from a period that already ended"),
    dashboard: {
      ...busyDashboard,
      usage: { ...busyDashboard.usage, quota_reset_date: "2025-06-01" },
    },
  },

  "mcp-recovering": {
    ...healthy("MCP · broker stopped, Maximal restarting it"),
    mcp: { ...twoMcpEndpoints, broker: { state: "recovering", problem: null } },
  },

  "mcp-stuck": {
    ...healthy("MCP · broker keeps crashing (retries paused)"),
    mcp: { ...twoMcpEndpoints, broker: { state: "stuck", problem: null } },
  },

  "mcp-not-installed": {
    ...healthy("MCP · broker missing from this install"),
    mcp: { ...twoMcpEndpoints, broker: { state: "unavailable", problem: "not-installed" } },
  },

  "requests-waiting": {
    ...healthy("Requests · a form and a link waiting for an answer"),
    requests: waitingRequests,
  },

  "mcp-found": {
    ...healthy("MCP · nothing added yet, Work IQ found on this machine"),
    mcp: { endpoints: [], broker: { state: "off", problem: null }, available: [workiqFound] },
  },

  "mcp-catalog-missing": {
    ...healthy("MCP · nothing added yet, Work IQ not installed"),
    mcp: {
      endpoints: [],
      broker: { state: "off", problem: null },
      available: [
        { id: "workiq", label: "Work IQ", status: "not-installed", install: workiqFound.install },
      ],
    },
  },
} satisfies Record<string, Scenario>

export type ScenarioId = keyof typeof SCENARIOS
export const defaultScenarioId: ScenarioId = "signed-in"

/** A scenario with the optional per-surface fixtures filled from the shared defaults. */
export function resolveScenario(id: ScenarioId): ResolvedScenario {
  const s: Scenario = SCENARIOS[id]
  return {
    ...s,
    mcp: s.mcp ?? twoMcpEndpoints,
    requests: s.requests ?? { requests: [] },
    clients: s.clients ?? recentClients,
    dashboard: s.dashboard ?? busyDashboard,
  }
}
