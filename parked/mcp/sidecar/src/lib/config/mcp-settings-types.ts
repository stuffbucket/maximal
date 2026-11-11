/**
 * Parked: the Settings wire types for the MCP broker (`/settings/api/mcp`,
 * `/settings/api/requests`) and Work IQ's CLI-driven state. Extracted from
 * `src/lib/config/settings-types.ts` when the broker was parked. Not
 * compiled or imported by the build.
 */

import { z } from "zod"

// ── Brokered MCP endpoints (/settings/api/mcp) ──────────────────────────

export const McpClientId = z.enum(["claude-code", "claude-desktop"])
export type McpClientId = z.infer<typeof McpClientId>

export const McpClientOffer = z.object({
  id: McpClientId,
  name: z.string(),
  /** Maximal's integration for this client is on, so it can be offered. */
  available: z.boolean(),
  /** When not available, a more specific reason than "integration off":
   *  Claude Desktop has another provider's gateway profile applied, or
   *  Maximal found no Claude Code program it can run. */
  unavailableReason: z
    .enum(["other-provider-profile", "cli-missing"])
    .optional(),
  /** Maximal currently has this endpoint written into the client. */
  configured: z.boolean(),
})
export type McpClientOffer = z.infer<typeof McpClientOffer>

/** Where Work IQ is, step by step (see `workIqState` in
 *  src/lib/mcp-broker/workiq.ts):
 *   not-installed   its executable is gone
 *   eula-needed     the user hasn't accepted Microsoft's terms
 *   signin-needed   nobody has signed in on this account
 *   starting        Maximal is (re)starting it
 *   ready           signed in, and it offers its Microsoft 365 tools
 *   consent-needed  signed in, but it offers only its local tools: usually
 *                   the organization hasn't approved Work IQ */
export const WorkIqState = z.enum([
  "not-installed",
  "eula-needed",
  "signin-needed",
  "starting",
  "ready",
  "consent-needed",
])
export type WorkIqState = z.infer<typeof WorkIqState>

/** The sign-in Maximal runs for the user: `waiting` for them in the
 *  browser, `restarting` Work IQ afterwards; the rest say how the last one
 *  ended (`idle`: none, or it worked). */
export const WorkIqSignIn = z.enum([
  "idle",
  "waiting",
  "restarting",
  "failed",
  "timed-out",
  "cancelled",
])
export type WorkIqSignIn = z.infer<typeof WorkIqSignIn>

export const WorkIqStatus = z.object({
  state: WorkIqState,
  eulaAccepted: z.boolean(),
  signedInBefore: z.boolean(),
  /** Sign-in uses the browser (`disableBrokeredAuth=true`). */
  browserSignIn: z.boolean(),
  /** On macOS the UI offers browser sign-in and mentions the keychain. */
  macos: z.boolean(),
  signIn: WorkIqSignIn,
  /** The last line Work IQ wrote that reads like a problem. Server text. */
  lastProblem: z.string().nullable(),
})
export type WorkIqStatus = z.infer<typeof WorkIqStatus>

export const McpEndpointEntry = z.object({
  id: z.string(),
  label: z.string(),
  enabled: z.boolean(),
  /** Remembered client choices, used to pre-check the prompt. */
  clients: z.array(McpClientId),
  offered: z.array(McpClientOffer),
  /** Work IQ endpoints that are on: where its sign-in stands. */
  workiq: WorkIqStatus.optional(),
})
export type McpEndpointEntry = z.infer<typeof McpEndpointEntry>

export const WorkIqSignInRequest = z.object({
  /** The user chose to switch Work IQ to browser sign-in first. */
  useBrowserSignIn: z.boolean(),
})
export type WorkIqSignInRequest = z.infer<typeof WorkIqSignInRequest>

export const WorkIqActionResponse = z.object({ workiq: WorkIqStatus })
export type WorkIqActionResponse = z.infer<typeof WorkIqActionResponse>

/** The process that runs every MCP endpoint, as the Settings UI needs it:
 *  whether anything is wrong and whether Maximal is already fixing it.
 *   off         no endpoint is on
 *   starting    coming up (first start, or after a change)
 *   running     serving
 *   recovering  stopped unexpectedly; Maximal is restarting it on its own
 *   stuck       kept stopping; Maximal paused retries for a minute
 *   unavailable can't run on this install — `problem` says why */
export const McpBrokerHealth = z.object({
  state: z.enum([
    "off",
    "starting",
    "running",
    "recovering",
    "stuck",
    "unavailable",
  ]),
  problem: z.enum(["not-installed", "containment-unavailable"]).nullable(),
})
export type McpBrokerHealth = z.infer<typeof McpBrokerHealth>

/** A known MCP server Maximal looked for that isn't an endpoint yet. */
export const McpCatalogItem = z.object({
  id: z.string(),
  label: z.string(),
  status: z.enum(["ready", "not-installed"]),
  /** Absolute path of the executable Maximal found. */
  command: z.string().optional(),
  version: z.string().optional(),
  install: z.object({
    command: z.string(),
    url: z.string(),
    /** Host of the registry the command downloads from; null when nothing
     *  confirms one (the card then doesn't name a host). */
    registry: z.string().nullable(),
  }),
})
export type McpCatalogItem = z.infer<typeof McpCatalogItem>

export const McpEndpointsListResponse = z.object({
  endpoints: z.array(McpEndpointEntry),
  broker: McpBrokerHealth,
  /** Known servers to offer adding, installed or not. */
  available: z.array(McpCatalogItem),
})
export type McpEndpointsListResponse = z.infer<typeof McpEndpointsListResponse>

export const McpEndpointToggleRequest = z.object({
  enabled: z.boolean(),
  /** Omitted when turning off, so the remembered choice is kept. */
  clients: z.array(McpClientId).max(2).optional(),
})
export type McpEndpointToggleRequest = z.infer<typeof McpEndpointToggleRequest>

/** Where the broker got to before the apps were updated (see
 *  BrokerReadiness in src/lib/mcp-broker/supervisor.ts): `starting` means
 *  the wait ran out first, `failed` that it gave up, `off` that nothing
 *  runs it in this process, `setup-needed` that the endpoint is held back
 *  from the broker until its setup is done (Work IQ's terms and sign-in). */
export const McpBrokerReadiness = z.enum([
  "ready",
  "starting",
  "failed",
  "off",
  "setup-needed",
])
export type McpBrokerReadiness = z.infer<typeof McpBrokerReadiness>

export const McpEndpointToggleResponse = z.object({
  endpoint: McpEndpointEntry,
  /** Clients that already had an entry with this name; left unchanged. */
  skipped: z.array(z.object({ client: McpClientId, name: z.string() })),
  /** Clients Maximal couldn't add it to on this install, and why:
   *  `adapter-missing` = Claude Desktop needs maximal-mcp-broker, which
   *  wasn't found. */
  unavailable: z.array(
    z.object({
      client: McpClientId,
      name: z.string(),
      reason: z.enum(["adapter-missing"]),
    }),
  ),
  /** Clients whose config Maximal changed for it (added or took it out). */
  updated: z.array(z.object({ client: McpClientId, name: z.string() })),
  broker: McpBrokerReadiness,
  /** The app whose own entry for this server the endpoint now runs. */
  adoptedFrom: z.string().optional(),
  /** Environment names from that entry that were not copied. */
  droppedEnvironment: z.array(z.string()).optional(),
})
export type McpEndpointToggleResponse = z.infer<
  typeof McpEndpointToggleResponse
>

export const McpEndpointAddRequest = z.object({ catalogId: z.string().min(1) })
export type McpEndpointAddRequest = z.infer<typeof McpEndpointAddRequest>

export const McpEndpointAddResponse = z.object({ endpoint: McpEndpointEntry })
export type McpEndpointAddResponse = z.infer<typeof McpEndpointAddResponse>

export const McpEndpointRemoveResponse = z.object({
  /** Apps Maximal took this server's entry out of. */
  removedFrom: z.array(z.object({ client: McpClientId, name: z.string() })),
})
export type McpEndpointRemoveResponse = z.infer<
  typeof McpEndpointRemoveResponse
>

/** One field of a form an MCP server asked the user to fill in, normalized
 *  from its JSON Schema. Titles, descriptions and options are server text. */
export const PendingRequestField = z.object({
  name: z.string(),
  kind: z.enum(["boolean", "string", "number", "integer", "enum"]),
  title: z.string().optional(),
  description: z.string().optional(),
  required: z.boolean(),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  minLength: z.number().optional(),
  maxLength: z.number().optional(),
  format: z.enum(["email", "uri", "date", "date-time"]).optional(),
  minimum: z.number().optional(),
  maximum: z.number().optional(),
  /** For `enum`: the allowed values and how to show them. */
  options: z
    .array(z.object({ value: z.string(), label: z.string() }))
    .optional(),
})
export type PendingRequestField = z.infer<typeof PendingRequestField>

/** An MCP server's request for user input, waiting for an answer in
 *  Maximal: a form to fill in, or a URL to open. */
export const PendingRequest = z.object({
  id: z.string(),
  /** The MCP server (endpoint) asking, and its display name. */
  endpointId: z.string(),
  label: z.string(),
  /** The tool call the request belongs to, when known. */
  toolName: z.string().optional(),
  mode: z.enum(["form", "url"]),
  /** The server's message to the user. Untrusted; show as plain text. */
  message: z.string(),
  fields: z.array(PendingRequestField),
  url: z.string().optional(),
  /** Host of `url`, for showing where the link goes. */
  urlHost: z.string().optional(),
  receivedAt: z.string(),
  expiresAt: z.string(),
})
export type PendingRequest = z.infer<typeof PendingRequest>

export const PendingRequestsResponse = z.object({
  requests: z.array(PendingRequest),
})
export type PendingRequestsResponse = z.infer<typeof PendingRequestsResponse>

/** What the shell polls: enough to notice a new request, nothing more. */
export const PendingRequestsSummary = z.object({
  pending: z.number().int().nonnegative(),
  /** The most recent request's id, so a new one is noticed even when the
   *  count stays the same. */
  newestId: z.string().nullable(),
})
export type PendingRequestsSummary = z.infer<typeof PendingRequestsSummary>

export const PendingRequestAnswer = z.object({
  action: z.enum(["accept", "decline", "cancel"]),
  /** Form values, only with `accept` on a form. */
  content: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
    .optional(),
})
export type PendingRequestAnswer = z.infer<typeof PendingRequestAnswer>

export const PendingRequestAnswerResponse = z.object({ ok: z.literal(true) })
export type PendingRequestAnswerResponse = z.infer<
  typeof PendingRequestAnswerResponse
>
