import path from "node:path"

import type { McpBrokerConfig, McpServerConfig } from "./types"

const SECRET_NAME_PATTERN =
  /(?:^|_)(?:API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|TOKEN|SECRET|PASSWORD|PASSCODE|CREDENTIAL|MFA|OTP|COOKIE)(?:_|$)/u
const PROTECTED_PREFIX_PATTERN = /^(?:AZURE|COPILOT|GH|GITHUB|MICROSOFT|MSAL)_/u
const PROTECTED_NAMES = new Set(["ANTHROPIC_API_KEY", "MAXIMAL_SHELL_KEY"])

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
      "SYSTEMDRIVE",
      "SYSTEMROOT",
      "TEMP",
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
    initializeTimeoutMs: server.timeouts?.initializeMs ?? 30_000,
    callTimeoutMs: server.timeouts?.callMs ?? 120_000,
    shutdownTimeoutMs: server.timeouts?.shutdownMs ?? 2_000,
  }
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
): Array<string> {
  if (configuredPath !== undefined) return [configuredPath]

  const executableDirectory = path.dirname(executablePath)
  const suffix = process.platform === "win32" ? ".exe" : ""
  return [
    path.join(executableDirectory, `maximal-mcp-broker${suffix}`),
    path.resolve("packages/mcp-broker/dist/maximal-mcp-broker"),
  ]
}
