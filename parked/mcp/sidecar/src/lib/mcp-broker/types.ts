export type McpProtocolMode = "auto" | "legacy" | "modern"
export type McpOwnershipMode = "auto" | "exclusive" | "shareable"
export type McpInteractionMode = "auto" | "interactive" | "non-interactive"
export type McpElicitationMechanism =
  | "legacy-form"
  | "legacy-url"
  | "modern-input-required"
export type McpElicitationAction = "passthrough" | "maximal" | "deny"
/** Client apps Maximal can wire a brokered endpoint into. */
export type McpClientId = "claude-code" | "claude-desktop"

export interface McpElicitationRule {
  match: {
    toolNames?: Array<string>
    mechanisms?: Array<McpElicitationMechanism>
    modes?: Array<"form" | "url">
    fieldTypes?: Array<"boolean" | "string" | "number" | "integer" | "enum">
    urlHosts?: Array<string>
    maxProperties?: number
  }
  action: McpElicitationAction
}

export interface McpServerConfig {
  id: string
  label: string
  enabled?: boolean
  /** Clients the user chose for this endpoint; kept while it is off. */
  clients?: Array<McpClientId>
  /** Endpoint-specific key for `/mcp/<id>`; never sent to the broker. */
  apiKey?: string
  /** Catalog id this endpoint was added from; lets Maximal find the
   *  executable again after an upgrade moves it. */
  catalog?: string
  transport: {
    type: "stdio"
    command: string
    args?: Array<string>
    cwd?: string
  }
  versionProbe?: {
    args: Array<string>
    timeoutMs?: number
  }
  timeouts?: {
    startupMs?: number
    initializeMs?: number
    callMs?: number
    cancellationMs?: number
    shutdownMs?: number
  }
  environment?: {
    inherit?: Array<string>
    values?: Record<string, string>
    secretRefs?: Record<string, string>
  }
  classification?: {
    protocol?: McpProtocolMode
    interaction?: McpInteractionMode
    ownership?: McpOwnershipMode
  }
  limits?: {
    sessions?: number
    inflightPerSession?: number
    interactionRounds?: number
  }
  elicitation?: {
    /** passthrough (default): the client if it can show the request, else
     *  Maximal. maximal: always Maximal. deny: decline without asking. */
    defaultAction?: McpElicitationAction
    rules?: Array<McpElicitationRule>
    /** How long a request waits for an answer; default 5 minutes. */
    timeoutMs?: number
  }
}

export interface McpBrokerConfig {
  enabled?: boolean
  executablePath?: string
  supervision?: {
    startupTimeoutMs?: number
    heartbeatIntervalMs?: number
    heartbeatDeadlineMs?: number
    gracefulShutdownMs?: number
    restartBackoffMinMs?: number
    restartBackoffMaxMs?: number
    restartBudget?: number
    restartWindowMs?: number
    circuitResetMs?: number
  }
  limits?: {
    ipcFrameBytes?: number
    httpBodyBytes?: number
    requestSchemaBytes?: number
    pendingRequests?: number
  }
  servers?: Array<McpServerConfig>
  /** Install hints for known servers (`./catalog`). */
  catalog?: {
    /** Registry the install command downloads from (http or https). */
    npmRegistry?: string
  }
}
