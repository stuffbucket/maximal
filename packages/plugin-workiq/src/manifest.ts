import type { RemoteMcpConnectorManifest } from "@stuffbucket/maximal-connector-kit"

import { WORKIQ_LIMITS } from "./throttle"

/** Microsoft's hosted Work IQ MCP endpoint (Streamable HTTP). */
export const DEFAULT_ENDPOINT = "https://workiq.svc.cloud.microsoft/mcp"

/** Work and school accounts only. */
export const DEFAULT_AUTHORITY =
  "https://login.microsoftonline.com/organizations"

/** The "Work IQ CLI" first-party public client; tenants grant admin consent to it. */
export const WORKIQ_CLIENT_ID = "ba081686-5d24-4bc6-a0d6-d034ecffed87"

/** Token audience of the Work IQ MCP server. */
export const WORKIQ_SCOPES: ReadonlyArray<string> = [
  "fdcc1f02-fc51-4226-8753-f668596af7f7/WorkIQAgent.Ask",
]

/** The app's registered redirect; sign-in uses exactly this loopback port. */
export const REDIRECT_URI = "http://localhost:12798"

/** Where Microsoft publishes the Work IQ terms. */
export const TERMS_URL = "https://github.com/microsoft/work-iq"

/**
 * The Work IQ connector manifest. The sign-in setup is the one the Work IQ
 * CLI and agent-kit's tools use (same public client, authority, scope and
 * redirect).
 */
export const WORKIQ_MANIFEST: RemoteMcpConnectorManifest = {
  id: "workiq",
  kind: "connector",
  displayName: "Work IQ",
  description:
    "Microsoft 365 mail, meetings, chats, files and people through Microsoft's hosted Work IQ service.",
  homepage: TERMS_URL,
  settingsVersion: 1,
  connector: {
    transport: "streamable-http",
    endpoint: DEFAULT_ENDPOINT,
    auth: {
      type: "entra",
      clientId: WORKIQ_CLIENT_ID,
      authority: DEFAULT_AUTHORITY,
      scopes: [...WORKIQ_SCOPES],
      redirectUri: REDIRECT_URI,
    },
    terms: { url: TERMS_URL, label: "the Microsoft Work IQ terms" },
    limits: WORKIQ_LIMITS,
  },
}
