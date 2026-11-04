import path from "node:path"

import type {
  McpBrokerConfig,
  McpElicitationAction,
  McpElicitationRule,
  McpServerConfig,
} from "./types"

const SECRET_NAME_PATTERN =
  /(?:^|_)(?:API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|TOKEN|SECRET|PASSWORD|PASSCODE|CREDENTIAL|MFA|OTP|COOKIE)(?:_|$)/u
const PROTECTED_PREFIX_PATTERN = /^(?:AZURE|COPILOT|GH|GITHUB|MICROSOFT|MSAL)_/u
const PROTECTED_NAMES = new Set(["ANTHROPIC_API_KEY", "MAXIMAL_SHELL_KEY"])

/** What the broker's environment is built from. The MCP SDK gives each
 *  stdio server its own default set read from the broker's environment, so
 *  on Windows this covers that set too (USERNAME, PROGRAMFILES and so on). */
const BROKER_BASELINE_ENVIRONMENT =
  process.platform === "win32" ?
    [
      "APPDATA",
      "COMSPEC",
      "HOMEDRIVE",
      "HOMEPATH",
      "LOCALAPPDATA",
      "PATH",
      "PATHEXT",
      "PROCESSOR_ARCHITECTURE",
      "PROGRAMDATA",
      "PROGRAMFILES",
      "PROGRAMFILES(X86)",
      "PROGRAMW6432",
      "SYSTEMDRIVE",
      "SYSTEMROOT",
      "TEMP",
      "USERNAME",
      "USERPROFILE",
      "WINDIR",
    ]
  : ["HOME", "LOGNAME", "PATH", "SHELL", "TERM", "USER"]

export type BrokerConfigurationErrorCode =
  | "MCP_ENVIRONMENT_PROTECTED"
  | "MCP_SECRET_REFERENCE_UNAVAILABLE"

export class BrokerConfigurationError extends Error {
  readonly code: BrokerConfigurationErrorCode

  constructor(code: BrokerConfigurationErrorCode) {
    super(code)
    this.name = "BrokerConfigurationError"
    this.code = code
  }
}

export interface ResolvedBrokerEndpoint {
  id: string
  label: string
  command: string
  args: Array<string>
  cwd?: string
  environment: Record<string, string>
  protocol: "auto" | "legacy" | "modern"
  interaction: "auto" | "interactive" | "non-interactive"
  ownership: "auto" | "exclusive" | "shareable"
  initializeTimeoutMs: number
  callTimeoutMs: number
  shutdownTimeoutMs: number
  /** Concurrent sessions; each runs its own instance of the server. */
  maxSessions: number
  /** Who answers the server's requests for user input; see the broker's
   *  `elicitation.ts`. */
  elicitation: {
    defaultAction: McpElicitationAction
    rules: Array<McpElicitationRule>
    timeoutMs: number
  }
}

export interface ResolvedBrokerConfiguration {
  endpoints: Array<ResolvedBrokerEndpoint>
  httpBodyBytes: number
  heartbeatIntervalMs: number
}

/** Names that must never be passed to an MCP child: provider credentials
 *  and anything that looks like a secret. */
export function isProtectedEnvironmentName(name: string): boolean {
  return (
    PROTECTED_NAMES.has(name)
    || PROTECTED_PREFIX_PATTERN.test(name)
    || SECRET_NAME_PATTERN.test(name)
  )
}

function resolveEnvironment(
  server: McpServerConfig,
  source: NodeJS.ProcessEnv,
): Record<string, string> {
  const configuration = server.environment
  if (Object.keys(configuration?.secretRefs ?? {}).length > 0) {
    throw new BrokerConfigurationError("MCP_SECRET_REFERENCE_UNAVAILABLE")
  }

  const resolved: Record<string, string> = {}
  for (const name of configuration?.inherit ?? []) {
    if (isProtectedEnvironmentName(name)) {
      throw new BrokerConfigurationError("MCP_ENVIRONMENT_PROTECTED")
    }
    const value = source[name]
    if (value !== undefined) resolved[name] = value
  }

  for (const [name, value] of Object.entries(configuration?.values ?? {})) {
    if (isProtectedEnvironmentName(name)) {
      throw new BrokerConfigurationError("MCP_ENVIRONMENT_PROTECTED")
    }
    resolved[name] = value
  }

  return resolved
}

function resolveEndpoint(
  server: McpServerConfig,
  source: NodeJS.ProcessEnv,
): ResolvedBrokerEndpoint {
  return {
    id: server.id,
    label: server.label,
    command: server.transport.command,
    args: server.transport.args ?? [],
    ...(server.transport.cwd === undefined ?
      {}
    : { cwd: server.transport.cwd }),
    environment: resolveEnvironment(server, source),
    protocol: server.classification?.protocol ?? "auto",
    interaction: server.classification?.interaction ?? "auto",
    ownership: server.classification?.ownership ?? "auto",
    ...endpointBounds(server),
    elicitation: {
      defaultAction: server.elicitation?.defaultAction ?? "passthrough",
      rules: server.elicitation?.rules ?? [],
      timeoutMs: server.elicitation?.timeoutMs ?? 300_000,
    },
  }
}

/** Timeouts and the session cap, with their defaults. */
function endpointBounds(
  server: McpServerConfig,
): Pick<
  ResolvedBrokerEndpoint,
  "initializeTimeoutMs" | "callTimeoutMs" | "shutdownTimeoutMs" | "maxSessions"
> {
  return {
    initializeTimeoutMs: server.timeouts?.initializeMs ?? 30_000,
    callTimeoutMs: server.timeouts?.callMs ?? 120_000,
    shutdownTimeoutMs: server.timeouts?.shutdownMs ?? 2_000,
    maxSessions: server.limits?.sessions ?? 8,
  }
}

/** What a running broker built each endpoint's listener around. */
function listenerShape(endpoint: ResolvedBrokerEndpoint) {
  return {
    id: endpoint.id,
    protocol: endpoint.protocol,
    interaction: endpoint.interaction,
    ownership: endpoint.ownership,
  }
}

/** True when a broker running `current` can take `next` without a restart:
 *  the same endpoints, built the same way, differing only in how a new
 *  session's instance starts (command, args, environment, timeouts). Mirrors
 *  `isLiveUpdate` in the broker package, which re-checks it. */
export function isLiveUpdate(
  current: ResolvedBrokerConfiguration,
  next: ResolvedBrokerConfiguration,
): boolean {
  return (
    current.httpBodyBytes === next.httpBodyBytes
    && current.heartbeatIntervalMs === next.heartbeatIntervalMs
    && JSON.stringify(current.endpoints.map((e) => listenerShape(e)))
      === JSON.stringify(next.endpoints.map((e) => listenerShape(e)))
  )
}

export function resolveBrokerConfiguration(
  config: McpBrokerConfig,
  source: NodeJS.ProcessEnv = process.env,
): ResolvedBrokerConfiguration {
  return {
    endpoints: (config.servers ?? [])
      .filter((server) => server.enabled !== false)
      .map((server) => resolveEndpoint(server, source)),
    httpBodyBytes: config.limits?.httpBodyBytes ?? 1024 * 1024,
    heartbeatIntervalMs: config.supervision?.heartbeatIntervalMs ?? 2_000,
  }
}

export function brokerProcessEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  return Object.fromEntries(
    BROKER_BASELINE_ENVIRONMENT.flatMap((name) => {
      const value = source[name]
      return value === undefined ? [] : [[name, value]]
    }),
  )
}

export function brokerExecutableCandidates(
  configuredPath: string | undefined,
  executablePath = process.execPath,
  platform: NodeJS.Platform = process.platform,
): Array<string> {
  if (configuredPath !== undefined) return [configuredPath]

  const executableDirectory = path.dirname(executablePath)
  const suffix = platform === "win32" ? ".exe" : ""
  return [
    path.join(executableDirectory, `maximal-mcp-broker${suffix}`),
    // A development build: `bun build --compile` adds .exe on Windows.
    path.resolve(`packages/mcp-broker/dist/maximal-mcp-broker${suffix}`),
  ]
}
