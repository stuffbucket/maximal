/**
 * Request-side declarations for Anthropic-server-side web tools.
 *
 * Only the declaration types live here — they're consumed by the
 * rewriter and the policy checks. Result-block shapes (success/error)
 * live in web-tools-exec.ts where they're constructed.
 */

import { TOOL_TYPE, TOOL_NAME } from "./vocab"

interface DomainPolicy {
  max_uses?: number
  allowed_domains?: Array<string>
  blocked_domains?: Array<string>
}

export interface UserLocation {
  type: "approximate"
  city?: string
  region?: string
  country?: string
  timezone?: string
}

export interface WebSearchToolDecl extends DomainPolicy {
  type: typeof TOOL_TYPE.webSearch
  name: typeof TOOL_NAME.webSearch
  user_location?: UserLocation
}

export interface WebFetchToolDecl extends DomainPolicy {
  type: typeof TOOL_TYPE.webFetch
  name: typeof TOOL_NAME.webFetch
  citations?: { enabled: boolean }
  max_content_tokens?: number
}

export type WebToolDecl = WebSearchToolDecl | WebFetchToolDecl
