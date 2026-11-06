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
} from "../src/lib/config/settings-types"
import type { SessionView, SessionsResponse } from "../src/lib/token-usage/sessions-schema"
import type {
  PluginDetailView,
  PluginStatus,
  PluginToolView,
  PluginView,
  ToolGroup,
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
  /** GET /token-usage/sessions. A function, called per request, so every
   *  timestamp (cache expiry, last request, minute buckets) is relative to
   *  that moment rather than to when the module loaded. */
  sessions: () => SessionsResponse
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
  /** Optional on each scenario; `resolveScenario` fills the shared default.
   *  Each connector's full detail; the mock derives the list from it. */
  connectors?: Array<PluginDetailView>
  clients?: ActiveClientsFixture
  dashboard?: DashboardFixture
}

export type ResolvedScenario = Required<Omit<Scenario, "deviceCode">> &
  Pick<Scenario, "deviceCode">


const ISO = (offsetMs = 0): string => new Date(1_750_000_000_000 + offsetMs).toISOString()

// ---- shared building blocks (overridden per scenario as needed) ------------
const baseModels: ModelsListResponse = {
  count: 5,
  loaded_at: new Date().toISOString(),
  claude_code_auto: {
    applied: true,
    options: [
      { id: "claude-haiku-5-5", name: "Claude Haiku 5.5", vendor: "Anthropic", preview: false },
      { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", vendor: "Anthropic", preview: false },
      { id: "gpt-5.6-luna", name: "GPT-5.6 Luna", vendor: "OpenAI", preview: false },
      { id: "gpt-6.1-sol", name: "GPT-6.1 Sol", vendor: "OpenAI", preview: false },
    ],
    classifier_options: [
      { id: "claude-haiku-5-5", name: "Claude Haiku 5.5", vendor: "Anthropic", preview: false },
      { id: "gpt-5.6-luna", name: "GPT-5.6 Luna", vendor: "OpenAI", preview: false },
      { id: "gpt-6.1-sol", name: "GPT-6.1 Sol", vendor: "OpenAI", preview: false },
    ],
    fast: {
      configured: null,
      effective: "claude-haiku-5-5",
      source: "automatic",
      status: "ready",
      reason: "haiku",
    },
    capable: {
      configured: null,
      effective: "claude-sonnet-5-5",
      source: "automatic",
      status: "ready",
      reason: "sonnet",
    },
    classifier: {
      configured: null,
      effective: "claude-haiku-5-5",
      source: "automatic",
      status: "ready",
      reason: "haiku",
    },
  },
  models: [
    {
      id: "claude-haiku-5-5",
      name: "Claude Haiku 5.5",
      vendor: "Anthropic",
      family: "claude-haiku-5.5",
      type: "chat",
      preview: false,
      context_window_tokens: 1_000_000,
      max_output_tokens: 128_000,
      capabilities: { vision: true, tool_calls: true, streaming: true, reasoning: true },
    },
    {
      id: "claude-sonnet-5-5",
      name: "Claude Sonnet 5.5",
      vendor: "Anthropic",
      family: "claude-sonnet-5.5",
      type: "chat",
      preview: false,
      context_window_tokens: 1_000_000,
      max_output_tokens: 128_000,
      capabilities: { vision: true, tool_calls: true, streaming: true, reasoning: true },
    },
    {
      id: "gpt-5.6-luna",
      name: "GPT-5.6 Luna",
      vendor: "OpenAI",
      family: "gpt-5.6-luna",
      type: "chat",
      preview: false,
      context_window_tokens: 1_050_000,
      max_output_tokens: 128_000,
      capabilities: { vision: true, tool_calls: true, streaming: true, reasoning: true },
    },
    {
      id: "gpt-6.1-sol",
      name: "GPT-6.1 Sol",
      vendor: "OpenAI",
      family: "gpt-6.1-sol",
      type: "chat",
      preview: false,
      context_window_tokens: 1_050_000,
      max_output_tokens: 128_000,
      capabilities: { vision: true, tool_calls: true, streaming: true, reasoning: true },
    },
    {
      id: "text-embedding-3-small",
      name: "Embedding V3 small",
      vendor: "Azure OpenAI",
      family: "text-embedding-3-small",
      type: "embeddings",
      preview: false,
      context_window_tokens: null,
      max_output_tokens: null,
      capabilities: { vision: false, tool_calls: false, streaming: false, reasoning: false },
    },
  ],
}

const emptyModels: ModelsListResponse = {
  count: 0,
  loaded_at: null,
  models: [],
  claude_code_auto: {
    applied: false,
    options: [],
    classifier_options: [],
    fast: {
      configured: null,
      effective: null,
      source: "none",
      status: "unresolved",
      reason: "no-match",
    },
    capable: {
      configured: null,
      effective: null,
      source: "none",
      status: "unresolved",
      reason: "no-match",
    },
    classifier: {
      configured: null,
      effective: null,
      source: "none",
      status: "unresolved",
      reason: "no-match",
    },
  },
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
  models_cached: baseModels.models.length,
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
  url: "https://mxml.sh/",
  update_command: null,
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

// ---- connectors (plugins of kind "connector") -------------------------------
// Work IQ is the first connector. Its status text is the connector's own
// English (the UI renders it as written); the mock API (ui-harness-api.ts)
// walks it through these stages as the user accepts terms, signs in and out.
// Tool names, descriptions and inputs follow Work IQ's real tool list; the
// two marked "synthetic" were invented to complete the 6 / 5 / 3 grouping.
export type WorkiqStage = "terms-needed" | "signin-needed" | "working" | "ready" | "error"

export const WORKIQ_CONSENT_URL =
  "https://github.com/microsoft/work-iq/blob/main/ADMIN-INSTRUCTIONS.md"

const WORKIQ_ENDPOINT = "https://workiq.svc.cloud.microsoft/mcp"
const WORKIQ_AUTHORITY = "https://login.microsoftonline.com/organizations"

type ToolSeed = Omit<PluginToolView, "group" | "permission" | "permissionSource">

const str = (description: string): Record<string, unknown> => ({ type: "string", description })
const agentId = str("Optional agent ID to target a specific agent.")
const jsonBody = {
  description:
    "Structured JSON for the request. Supply as a JSON object or a JSON-encoded string.",
  anyOf: [{ type: "object", additionalProperties: true }, { type: "string" }],
}
const headers = {
  type: "object",
  description: "Optional extra HTTP headers, e.g. If-Match for an etag.",
  additionalProperties: { type: "string" },
}
const schema = (properties: Record<string, unknown>, required: Array<string> = []): ToolSeed["inputSchema"] => ({
  type: "object",
  properties,
  ...(required.length > 0 ? { required } : {}),
})

const readOnly = { readOnlyHint: true }
const destructive = { readOnlyHint: false, destructiveHint: true }

export const workiqToolSeeds: Array<ToolSeed> = [
  {
    name: "retrieve",
    description:
      "Search the user's M365 data (emails, files, meetings, Teams messages, people) and connected enterprise sources, returning raw per-source retrieval hits plus a model-friendly grounding markdown with inline [^id] citations that map back to each hit.",
    inputSchema: schema(
      {
        query: str("What to search for, in natural language."),
        includeDeveloperCard: { type: "boolean", description: "Also return the raw per-source developer card." },
        agentId,
        sources: { type: ["array", "null"], items: { type: "string" }, description: "Limit the search to these sources (mail, files, meetings, chats, people)." },
        maxResults: { type: "integer", minimum: 1, maximum: 50, description: "Most hits to return per source." },
      },
      ["query"],
    ),
    annotations: readOnly,
  },
  {
    name: "fetch_blob",
    description:
      "Fetch a binary file (document, image, photo) from a WorkIQ path — PDFs, Office files, profile photos, etc. Up to 4 MB for the raw file. Returns the file's bytes base64-encoded plus metadata. To read the file, decode the bytes with a tool that understands the format.",
    inputSchema: schema(
      {
        path: str("WorkIQ path of the file, e.g. /me/drive/items/{id}/content."),
        format: { type: "string", enum: ["base64", "text"], description: "How to return the bytes." },
        agentId,
      },
      ["path"],
    ),
    annotations: readOnly,
  },
  {
    name: "get_schema",
    description:
      "Get the request/response schema for a WorkIQ path and operation (CDDL by default; 'jsonschema' or 'typescript' on request). Only needed when you do not know the fields for a write, or a write returned 400. Standard Graph payloads don't need it.",
    inputSchema: schema(
      {
        path: str("WorkIQ path, e.g. /me/events."),
        operationType: { type: "string", enum: ["get", "create", "update", "delete", "action"], description: "The operation to describe." },
        format: { type: "string", enum: ["cddl", "jsonschema", "typescript"], description: "Schema language. Defaults to cddl." },
        agentId,
      },
      ["path", "operationType"],
    ),
    annotations: readOnly,
  },
  {
    name: "call_function",
    description:
      "Call a read-only WorkIQ function. Graph functions use HTTP GET; provider functions may accept structured JSON parameters. Functions compute or synthesize data rather than simply reading entities — e.g., delta queries, search, reminder views and free/busy lookups.",
    inputSchema: schema(
      {
        functionUrl: str(
          "WorkIQ function path to call (e.g., /me/messages/delta(), /me/drive/root/search(q='budget'), /me/reminderView(startDateTime='...',endDateTime='...')). Must be a relative path — do not include a base URL.",
        ),
        agentId,
        jsonBody: {
          ...jsonBody,
          description:
            "OPTIONAL — structured parameters for a provider function. Available only when enabled for the caller. Supply as a JSON object or JSON-encoded string.",
        },
      },
      ["functionUrl"],
    ),
    annotations: readOnly,
  },
  {
    name: "fetch",
    description:
      "Fetch one or more WorkIQ entities by path. Use well-known Microsoft Graph paths directly, e.g. /me/messages, /me/events/{id}, /me/calendarView?startDateTime=...&endDateTime=..., /me/manager, /me/drive/recent.",
    inputSchema: schema(
      {
        entityUrls: { type: "array", items: { type: "string" }, description: "Relative WorkIQ paths to fetch." },
        agentId,
      },
      ["entityUrls"],
    ),
    annotations: readOnly,
  },
  {
    // synthetic
    name: "list_entities",
    description:
      "List a WorkIQ collection by path, a page at a time, e.g. /me/mailFolders/inbox/messages or /me/joinedTeams. Returns the items and a cursor for the next page.",
    inputSchema: schema(
      {
        collectionUrl: str("Relative WorkIQ path of the collection."),
        top: { type: "integer", minimum: 1, maximum: 100, description: "Page size." },
        cursor: str("Cursor from the previous page."),
        agentId,
      },
      ["collectionUrl"],
    ),
    annotations: readOnly,
  },
  {
    name: "accept_eula",
    description:
      "Accept the End User License Agreement (EULA) to enable full access to WorkIQ tools. The EULA URL should be https://github.com/microsoft/work-iq. This action requires explicit user confirmation and cannot be undone from here.",
    inputSchema: schema({ eulaUrl: str("The EULA URL being accepted.") }, ["eulaUrl"]),
    annotations: destructive,
  },
  {
    name: "delete_entity",
    description:
      "Delete a WorkIQ entity by path. Sends HTTP DELETE to the entity path. Returns confirmation with status code on success. WorkIQ entity paths borrow from the conventions of Microsoft Graph. If the path or ID is wrong the call fails with 404 and nothing is deleted.",
    inputSchema: schema(
      { entityUrl: str("Relative WorkIQ path of the entity to delete."), headers, agentId },
      ["entityUrl"],
    ),
    annotations: destructive,
  },
  {
    // synthetic
    name: "invoke_action",
    description:
      "Invoke a WorkIQ action by POSTing to its path, e.g. /me/sendMail, /me/events/{id}/accept or /me/messages/{id}/move. Actions change data or send things on the user's behalf.",
    inputSchema: schema(
      { actionUrl: str("Relative WorkIQ path of the action."), jsonBody, agentId },
      ["actionUrl"],
    ),
    annotations: destructive,
  },
  {
    name: "create_entity",
    description:
      "Create a new WorkIQ entity by POSTing JSON to a parent collection path. Call it directly for standard Graph payloads (e.g. event subject/start/end, message subject/body/toRecipients, mailFolder displayName, contact names and emails); use get_schema only if a create returned 400.",
    inputSchema: schema(
      { parentUrl: str("Relative WorkIQ path of the parent collection."), jsonBody, agentId },
      ["parentUrl", "jsonBody"],
    ),
    annotations: destructive,
  },
  {
    name: "update_entity",
    description:
      "Update an existing WorkIQ entity by writing JSON to its path. Call it directly for standard fields (e.g. isRead, flag, subject, location, start/end, displayName); use get_schema only if you do not know the fields or the update returned 400.",
    inputSchema: schema(
      { entityUrl: str("Relative WorkIQ path of the entity."), jsonBody, headers, agentId },
      ["entityUrl", "jsonBody"],
    ),
    annotations: destructive,
  },
  {
    name: "ask",
    description:
      "Ask a question to Microsoft 365 Copilot for information about emails, meetings, files, and other M365 data. Returns the answer as text content, with conversationId in structured content for multi-turn conversations.",
    inputSchema: schema(
      {
        question: str("The question to ask"),
        fileUrls: {
          description: "Optional list of OneDrive or SharePoint file URLs to use as context",
          type: ["array", "null"],
          items: { type: ["string"] },
        },
        conversationId: str("Optional conversation ID to continue an existing conversation"),
        agentId: str("Optional agent ID to target a specific agent. Defaults to M365 Copilot."),
      },
      ["question"],
    ),
    outputSchema: {
      type: "object",
      properties: { conversationId: { type: "string" } },
    },
  },
  {
    name: "list_agents",
    description:
      "List available Microsoft 365 Copilot agents. Returns agent IDs that can be passed to ask's agentId parameter.",
    inputSchema: schema({}),
  },
  {
    name: "get_debug_link",
    description:
      "Generates a share or debug link for a Work IQ conversation after requesting explicit user confirmation through the MCP host. Requires a host that supports form elicitation and obtains the human's response; without one, the call fails.",
    inputSchema: schema(
      {
        linkType: { type: "string", enum: ["share", "debug"], description: "Which link to create." },
        conversationId: str("The conversation to link to."),
      },
      ["linkType", "conversationId"],
    ),
  },
]

/** Annotation grouping, as the host infers it. */
function toolGroup(tool: ToolSeed): ToolGroup {
  if (tool.annotations?.readOnlyHint === true) return "read-only"
  if (tool.annotations?.destructiveHint === true) return "write-delete"
  return "other"
}

/** The user's explicit choices in the fixtures: one write tool and one
 *  other tool blocked, so those groups read "Custom". */
export const workiqBlocked: ReadonlyArray<string> = ["delete_entity", "get_debug_link"]

export function workiqToolViews(blocked: ReadonlyArray<string> = workiqBlocked): Array<PluginToolView> {
  return workiqToolSeeds.map((seed) => ({
    ...seed,
    group: toolGroup(seed),
    permission: blocked.includes(seed.name) ? "block" : "allow",
    permissionSource: blocked.includes(seed.name) ? "user" : "default",
  }))
}

export function toolCounts(tools: ReadonlyArray<PluginToolView>): PluginView["toolCounts"] {
  const count = (group: ToolGroup): number => tools.filter((tool) => tool.group === group).length
  return {
    total: tools.length,
    byGroup: { "read-only": count("read-only"), "write-delete": count("write-delete"), other: count("other") },
  }
}

export function workiqStatus(stage: WorkiqStage): PluginStatus {
  switch (stage) {
    case "terms-needed":
      return {
        state: "needs-setup",
        code: "terms-needed",
        summary: "Accept Microsoft’s Work IQ terms to continue",
        detail:
          "Work IQ reads your Microsoft 365 work data (mail, meetings, files) on your behalf. Read Microsoft’s terms at https://github.com/microsoft/work-iq, then accept them here.",
        actions: [
          {
            id: "accept-terms",
            label: "Accept terms",
            kind: "primary",
            confirm: "Record that you accept Microsoft’s terms for Work IQ (https://github.com/microsoft/work-iq)?",
          },
        ],
      }
    case "signin-needed":
      return {
        state: "needs-setup",
        code: "signin-needed",
        summary: "Sign in to Work IQ",
        detail:
          "Sign in with your Microsoft 365 work account. A browser window opens to finish; Maximal never sees your password.",
        actions: [{ id: "sign-in", label: "Sign in", kind: "primary" }],
      }
    case "working":
      return {
        state: "working",
        code: "signing-in",
        summary: "Waiting for you to finish signing in…",
        detail: "Finish signing in in your browser. Maximal waits up to five minutes.",
        actions: [{ id: "cancel-sign-in", label: "Cancel sign-in", kind: "secondary" }],
      }
    case "ready":
      return {
        state: "ready",
        code: "ready",
        summary: "Signed in and ready",
        facts: [
          { label: "Account", value: "alex.rivera@contoso.com" },
          { label: "Tenant", value: "Contoso Ltd" },
          { label: "Protocol", value: "MCP 2025-11-25" },
        ],
        actions: [
          {
            id: "sign-out",
            label: "Sign out",
            kind: "destructive",
            confirm: "Sign out of Work IQ? Maximal removes the saved sign-in from this computer.",
          },
        ],
      }
    case "error":
      return {
        state: "error",
        code: "consent-needed",
        summary: "Your organization hasn’t approved Work IQ yet",
        detail:
          "An admin must grant consent for the Work IQ app, and your account needs a Microsoft 365 Copilot license. Send your admin " +
          WORKIQ_CONSENT_URL,
        facts: [{ label: "Account", value: "alex.rivera@contoso.com" }],
        actions: [
          { id: "sign-in", label: "Sign in again", kind: "secondary" },
          { id: "sign-out", label: "Sign out", kind: "destructive", confirm: "Sign out of Work IQ?" },
        ],
      }
  }
}

/** The config schema Work IQ's connector kit publishes (z.toJSONSchema, input side). */
export const workiqConfigSchema: PluginDetailView["configSchema"] = {
  type: "object",
  properties: {
    endpoint: {
      type: "string",
      format: "uri",
      default: WORKIQ_ENDPOINT,
      title: "Endpoint",
      description: "Work IQ MCP endpoint (Streamable HTTP).",
      "x-maximal-advanced": true,
    },
    authority: {
      type: "string",
      format: "uri",
      default: WORKIQ_AUTHORITY,
      title: "Sign-in authority",
      description: "Microsoft Entra authority used for sign-in.",
      "x-maximal-advanced": true,
    },
  },
  additionalProperties: false,
}

/** Tools last seen when the catalog was cached: three days before "now". */
export const catalogSeenAt = (): string => new Date(Date.now() - 3 * 86_400_000).toISOString()

interface WorkiqOptions {
  /** Off when omitted. */
  stage?: WorkiqStage
  /** On, but it didn't start: `error` says why. */
  failed?: string
  /** Claude Code integration is off in Apps, so it can't be offered. */
  claudeCodeUnavailable?: boolean
  /** Whether Claude Code is ticked. */
  selected?: boolean
  /** Claude Code already runs its own Work IQ, so Maximal adds none. */
  standalone?: { name: string; source: "server" | "plugin" }
  /** Not running live, but a catalog from an earlier sign-in is cached. */
  cached?: boolean
  /** The stored config (defaults when omitted; `null`: the settings file
   *  is unreadable, so there is none to show). */
  config?: Record<string, unknown> | null
}

/** Work IQ's `GET /settings/api/plugins/:id`. */
export function workiqDetail({
  stage,
  failed,
  claudeCodeUnavailable = false,
  selected = true,
  standalone,
  cached = false,
  config = { endpoint: WORKIQ_ENDPOINT, authority: WORKIQ_AUTHORITY },
}: WorkiqOptions = {}): PluginDetailView {
  const enabled = stage !== undefined || failed !== undefined
  const live = stage === "ready" && failed === undefined
  const tools = live || cached ? workiqToolViews() : []
  const manifest: PluginDetailView["manifest"] = {
    id: "workiq",
    kind: "connector",
    displayName: "Work IQ",
    description: "Lets your apps ask about your Microsoft 365 work: mail, meetings, files and people.",
    homepage: "https://github.com/microsoft/work-iq",
    connector: {
      transport: "streamable-http",
      endpoint: typeof config?.endpoint === "string" ? config.endpoint : WORKIQ_ENDPOINT,
      auth: { type: "entra" },
      terms: { url: "https://github.com/microsoft/work-iq", label: "Microsoft Work IQ terms" },
    },
  }
  return {
    id: manifest.id,
    kind: manifest.kind,
    source: "built-in",
    displayName: manifest.displayName,
    description: manifest.description,
    homepage: manifest.homepage,
    manifest,
    enabled,
    lifecycle: failed !== undefined ? "failed" : stage ? "active" : "disabled",
    ...(failed !== undefined ? { error: failed } : {}),
    ...(stage && failed === undefined ? { status: workiqStatus(stage) } : {}),
    toolCounts: toolCounts(tools),
    toolsSource: live ? "live" : tools.length > 0 ? "cache" : "none",
    clients: [
      {
        id: "claude-code",
        selected: enabled && selected,
        available: !claudeCodeUnavailable,
        ...(claudeCodeUnavailable
          ? { reason: "Claude Code isn’t routed through Maximal. Turn it on in Apps to add Work IQ to it." }
          : {}),
        ...(standalone ? { standalone } : {}),
      },
    ],
    endpoint: "http://localhost:4141/mcp/workiq",
    settingsVersion: 1,
    ...(config ? { config } : {}),
    configSchema: workiqConfigSchema,
    tools,
    ...(tools.length > 0 ? { catalogUpdatedAt: live ? new Date().toISOString() : catalogSeenAt() } : {}),
  }
}

/** The list item for a detail: the same object minus the detail-only keys. */
export function listItem(detail: PluginDetailView): PluginView {
  const { settingsVersion: _v, config: _c, configSchema: _s, tools: _t, catalogUpdatedAt: _u, ...item } = detail
  return item
}

const workiqOff: Array<PluginDetailView> = [workiqDetail()]

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

const noSessions = (): SessionsResponse => ({ flow_per_min: 0, sessions: [] })

const MIN = 60_000

type SessionOverrides = Pick<SessionView, "id" | "client" | "model" | "state"> &
  Partial<Omit<SessionView, "cache" | "context">> & {
    cache: SessionView["cache"]
    context: SessionView["context"]
  }

/** A session row; rate is the mean of the last 5 minute buckets, as the server computes it. */
function session(o: SessionOverrides, buckets: Array<number>, nowMs: number): SessionView {
  const minutes = recentMinutes(buckets)
  const last5 = buckets.slice(-5)
  const rate = Math.round(last5.reduce((sum, n) => sum + n, 0) / last5.length)
  const cacheRead = o.cache.last_cache_read_tokens > 0 ? rate * 0.16 : 0
  const cacheWrite = o.cache.last_cache_read_tokens > 0 ? rate * 0.08 : 0
  const output = rate * 0.34
  const input = rate - output - cacheRead - cacheWrite
  const rates = {
    input_per_min: input,
    output_per_min: output,
    cache_read_per_min: cacheRead,
    cache_write_per_min: cacheWrite,
    total_per_min: rate,
  }
  return {
    client_label: null,
    started_at_ms: nowMs - 40 * MIN,
    last_request_at_ms: nowMs - 30_000,
    total_tokens: buckets.reduce((sum, n) => sum + n, 0) * 3,
    request_count: 12,
    ...o,
    rate_per_min: rate,
    rates,
    model_rates: [{ model: o.model, ...rates }],
    minutes,
  }
}

/** The live-sessions scenario: every state the Dashboard's sessions view draws.
 *  One streaming session, three warm ones with different cache confidence
 *  (observed, requested, estimated), one about to go cold, two cold (one
 *  downgraded), and the unattributed Claude Desktop row. Context fills: 30%, 78% and 93%. */
function liveSessions(): SessionsResponse {
  const now = Date.now()
  const claude = { client: "claude-code" } as const
  // Codex sizes its window from its catalog; Copilot's ceiling is lower, and
  // Maximal's injected compaction sits at 90% of that ceiling.
  const codexWindow = { window_tokens: 272_000, ceiling_tokens: 128_000, compact_at_tokens: 115_200 }
  const claudeWindow = { window_tokens: 200_000, ceiling_tokens: 200_000, compact_at_tokens: null }
  return {
    // Trailing minute across all sessions, plus what the streaming reply has emitted so far.
    flow_per_min: 41_800,
    sessions: [
      // Streaming: a 1 h requested cache, 78% full, rate climbing at the end.
      session(
        {
          id: "4f1c9a52-7d3e-4b08-9a61-2c5e8d7f0b13",
          ...claude,
          client_label: "Laptop",
          model: "claude-sonnet-4-5",
          state: "streaming",
          started_at_ms: now - 52 * MIN,
          last_request_at_ms: now - 25_000,
          request_count: 31,
          cache: {
            ttl_s: 3_600,
            expires_at_ms: now - 25_000 + 3_600_000,
            confidence: "requested",
            downgraded: false,
            downgraded_from_s: null,
            last_cache_read_tokens: 148_200,
          },
          context: {
            used_tokens: 156_000,
            ...claudeWindow,
            window_source: "models-endpoint",
            compacted_at_ms: now - 31 * MIN,
          },
        },
        [3_100, 2_400, 4_800, 0, 5_600, 7_900, 6_200, 9_400, 8_800, 11_300, 10_100, 14_600, 18_900, 27_400, 41_000],
        now,
      ),
      // Warm, cache lifetime confirmed by a cache read after a long gap; 30% full.
      session(
        {
          id: "b7e20d64-1a95-4c3f-8e72-5f9a0c4d6e21",
          ...claude,
          client_label: "Laptop",
          model: "claude-opus-4-5",
          state: "warm",
          started_at_ms: now - 2 * 3_600_000,
          last_request_at_ms: now - 70_000,
          request_count: 58,
          cache: {
            ttl_s: 3_600,
            expires_at_ms: now - 70_000 + 3_600_000,
            confidence: "observed",
            downgraded: false,
            downgraded_from_s: null,
            last_cache_read_tokens: 58_900,
          },
          context: {
            used_tokens: 60_000,
            ...claudeWindow,
            window_source: "models-endpoint",
            compacted_at_ms: null,
          },
        },
        [9_200, 12_400, 0, 0, 6_800, 15_300, 11_000, 8_700, 0, 4_200, 13_800, 9_600, 5_100, 7_300, 6_400],
        now,
      ),
      // Warm Codex session: GPT caches automatically, so the lifetime is a guess;
      // 93% of Copilot's ceiling. Its key is the one the integration made, so
      // it has no label of its own.
      session(
        {
          id: "0c8d3e17-9b42-4f6a-a1d5-7e3b2f8c9d04",
          client: "codex",
          client_label: null,
          model: "gpt-5-codex",
          state: "warm",
          started_at_ms: now - 74 * MIN,
          last_request_at_ms: now - 150_000,
          request_count: 44,
          cache: {
            ttl_s: 300,
            expires_at_ms: now - 150_000 + 300_000,
            confidence: "estimated",
            downgraded: false,
            downgraded_from_s: null,
            last_cache_read_tokens: 231_500,
          },
          context: {
            used_tokens: 119_000,
            ...codexWindow,
            window_source: "codex-catalog",
            compacted_at_ms: now - 48 * MIN,
          },
        },
        [14_000, 16_800, 21_500, 0, 0, 18_200, 24_900, 22_100, 0, 19_600, 28_300, 17_400, 9_800, 5_200, 3_600],
        now,
      ),
      // Warm, cache lifetime requested: ordinary 5-minute cache, a minute and a half old; 12% full.
      session(
        {
          id: "e92a5b08-3c71-4d0e-b6f4-8a1d7c2e5f39",
          ...claude,
          client_label: "Build server",
          model: "claude-sonnet-4-5",
          state: "warm",
          started_at_ms: now - 19 * MIN,
          last_request_at_ms: now - 90_000,
          request_count: 9,
          cache: {
            ttl_s: 300,
            expires_at_ms: now - 90_000 + 300_000,
            confidence: "requested",
            downgraded: false,
            downgraded_from_s: null,
            last_cache_read_tokens: 22_400,
          },
          context: {
            used_tokens: 24_000,
            ...claudeWindow,
            window_source: "models-endpoint",
            compacted_at_ms: null,
          },
        },
        [0, 0, 0, 0, 0, 0, 2_800, 5_400, 8_100, 3_900, 6_700, 0, 4_500, 2_100, 0],
        now,
      ),
      // Within 20 s of going cold.
      session(
        {
          id: "7a4f1e90-6d28-4b53-9c07-3e8b5a2d1f66",
          ...claude,
          model: "claude-haiku-4-5",
          state: "warm",
          started_at_ms: now - 33 * MIN,
          last_request_at_ms: now - 280_000,
          request_count: 17,
          cache: {
            ttl_s: 300,
            expires_at_ms: now + 20_000,
            confidence: "requested",
            downgraded: false,
            downgraded_from_s: null,
            last_cache_read_tokens: 9_800,
          },
          context: {
            used_tokens: 11_000,
            ...claudeWindow,
            window_source: "models-endpoint",
            compacted_at_ms: null,
          },
        },
        [1_900, 3_200, 2_600, 4_100, 1_300, 2_800, 3_700, 1_100, 2_300, 900, 1_600, 400, 0, 0, 0],
        now,
      ),
      // Cold: the 1 h lifetime failed twice, so the countdown fell back to 5 minutes.
      session(
        {
          id: "d15b8c36-0e7a-4a29-8f43-6c9d2b7e4a58",
          ...claude,
          client_label: "Build server",
          model: "claude-opus-4-5",
          state: "cold",
          started_at_ms: now - 3 * 3_600_000,
          last_request_at_ms: now - 14 * MIN,
          request_count: 26,
          cache: {
            ttl_s: 300,
            expires_at_ms: now - 14 * MIN + 300_000,
            confidence: "estimated",
            downgraded: true,
            downgraded_from_s: 3_600,
            last_cache_read_tokens: 0,
          },
          context: {
            used_tokens: 88_000,
            ...claudeWindow,
            window_source: "models-endpoint",
            compacted_at_ms: null,
          },
        },
        [6_100, 3_800, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        now,
      ),
      // Cold for most of an hour.
      session(
        {
          id: "93e6a0b2-8f14-4c75-a2d9-1b5c7e3f8a40",
          client: "codex",
          client_label: null,
          model: "gpt-5-mini",
          state: "cold",
          started_at_ms: now - 5 * 3_600_000,
          last_request_at_ms: now - 47 * MIN,
          request_count: 6,
          total_tokens: 41_300,
          cache: {
            ttl_s: 300,
            expires_at_ms: now - 47 * MIN + 300_000,
            confidence: "estimated",
            downgraded: false,
            downgraded_from_s: null,
            last_cache_read_tokens: 6_300,
          },
          context: {
            used_tokens: 7_200,
            ...codexWindow,
            window_source: "codex-catalog",
            compacted_at_ms: null,
          },
        },
        Array(15).fill(0),
        now,
      ),
      // Requests with no session id fold into one row per client; the window is unknown.
      session(
        {
          id: "other:claude-desktop",
          client: "claude-desktop",
          client_label: null,
          model: "claude-sonnet-4-5",
          state: "cold",
          started_at_ms: now - 6 * 3_600_000,
          last_request_at_ms: now - 22 * MIN,
          request_count: 14,
          total_tokens: 186_000,
          cache: {
            ttl_s: 0,
            expires_at_ms: null,
            confidence: "estimated",
            downgraded: false,
            downgraded_from_s: null,
            last_cache_read_tokens: 0,
          },
          context: {
            used_tokens: 0,
            window_tokens: null,
            ceiling_tokens: null,
            compact_at_tokens: null,
            window_source: "model-listing",
            compacted_at_ms: null,
          },
        },
        [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        now,
      ),
    ],
  }
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
  sessions: noSessions,
}

const emptyDashboard: DashboardFixture = {
  usage: { quota_snapshots: null },
  tokenUsage: { totals: ZERO_TOTALS, byModel: [], recent_minutes: recentMinutes(Array(15).fill(0)) },
  tokenEvents: [],
  sessions: noSessions,
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
    models: emptyModels,
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
          { ...a, enabled: false, status: "not-installed" as const, installs: [], install: { method: "curl", command: "curl -fsSL https://claude.ai/install.sh | sh", automatic: null } }
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
      url: "https://mxml.sh/",
      update_command: null,
      enabled: true,
      checked_at: ISO(-30_000),
      last_error: null,
    },
    ghStatus: ghAvailable,
  },

  "update-available-apt": {
    label: "Diagnostics · update available (apt install)",
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
      url: "https://github.com/stuffbucket/maximal/blob/main/docs/linux.md#update",
      update_command:
        "sudo apt update && sudo apt install --only-upgrade maximal maximal-desktop",
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
    models: emptyModels,
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

  "live-sessions": {
    ...healthy("Dashboard · live sessions: streaming, warm, about to go cold, cold"),
    dashboard: { ...busyDashboard, sessions: liveSessions },
  },

  "connectors-off": {
    ...healthy("Connectors · Work IQ off, nothing seen yet"),
    connectors: workiqOff,
  },

  "connectors-list": {
    ...healthy("Connectors · the list, Work IQ ready"),
    connectors: [workiqDetail({ stage: "ready" })],
  },

  "connectors-detail-ready": {
    ...healthy("Connectors · Work IQ ready: 14 tools, two blocked"),
    connectors: [workiqDetail({ stage: "ready" })],
  },

  "connectors-detail-terms-needed": {
    ...healthy("Connectors · Work IQ on, Microsoft’s terms to accept"),
    connectors: [workiqDetail({ stage: "terms-needed" })],
  },

  "connectors-detail-signin-needed-cached": {
    ...healthy("Connectors · Work IQ signed out, tools from the cached catalog"),
    connectors: [workiqDetail({ stage: "signin-needed", cached: true })],
  },

  "connectors-detail-working": {
    ...healthy("Connectors · Work IQ waiting for the browser sign-in"),
    connectors: [workiqDetail({ stage: "working", cached: true })],
  },

  "connectors-detail-error": {
    ...healthy("Connectors · Work IQ signed in, but the organization hasn’t approved it"),
    connectors: [workiqDetail({ stage: "error", cached: true })],
  },

  "connectors-detail-failed": {
    ...healthy("Connectors · Work IQ didn’t start (unreadable settings file)"),
    connectors: [
      workiqDetail({
        failed:
          "~/.local/share/copilot-api/plugins/workiq/settings.json isn’t valid JSON (Unexpected token } at line 9). Maximal left the file as it is.",
        cached: true,
        config: null,
      }),
    ],
  },

  "connectors-detail-config-error": {
    ...healthy("Connectors · Work IQ didn’t start (invalid endpoint in its configuration)"),
    connectors: [
      workiqDetail({
        failed: "config.endpoint: Invalid URL",
        cached: true,
        config: { endpoint: "workiq.svc.cloud.microsoft/mcp", authority: "https://login.microsoftonline.com/organizations" },
      }),
    ],
  },

  "connectors-claude-code-off": {
    ...healthy("Connectors · Work IQ ready, Claude Code isn’t set up in Apps"),
    connectors: [workiqDetail({ stage: "ready", claudeCodeUnavailable: true })],
  },

  "connectors-standalone-server": {
    ...healthy("Connectors · Claude Code already has its own Work IQ server"),
    connectors: [workiqDetail({ stage: "ready", standalone: { name: "workiq", source: "server" } })],
  },

  "connectors-standalone-plugin": {
    ...healthy("Connectors · Claude Code already has Work IQ from Microsoft’s plugin"),
    connectors: [workiqDetail({ stage: "ready", standalone: { name: "workiq@work-iq", source: "plugin" } })],
  },

} satisfies Record<string, Scenario>

export type ScenarioId = keyof typeof SCENARIOS
export const defaultScenarioId: ScenarioId = "signed-in"

/** A scenario with the optional per-surface fixtures filled from the shared defaults. */
export function resolveScenario(id: ScenarioId): ResolvedScenario {
  const s: Scenario = SCENARIOS[id]
  return {
    ...s,
    connectors: s.connectors ?? workiqOff,
    clients: s.clients ?? recentClients,
    dashboard: s.dashboard ?? busyDashboard,
  }
}
