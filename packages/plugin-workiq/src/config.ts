import { z } from "zod"

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

/** Loopback port registered as the app's redirect URI (`http://localhost:12798`). */
export const REDIRECT_PORT = 12798

/** Where Microsoft publishes the Work IQ terms. */
export const TERMS_URL = "https://github.com/microsoft/work-iq"

const httpUrl = z.url({ protocol: /^https?$/ })

export const Config = z.object({
  /** Work IQ MCP endpoint. */
  endpoint: httpUrl.default(DEFAULT_ENDPOINT),
  /** Microsoft Entra authority used for sign-in. */
  authority: httpUrl.default(DEFAULT_AUTHORITY),
})
export type Config = z.output<typeof Config>
