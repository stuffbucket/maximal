import type { ConnectorAuthManifest } from "../manifest"
import type { AuthStrategy } from "./token-provider"

import { entraAuth } from "./entra"
import { mcpOAuth } from "./mcp-oauth"
import { noAuth } from "./none"

/** The built-in strategy for a manifest's `connector.auth`. */
export function authStrategyFor(auth: ConnectorAuthManifest): AuthStrategy {
  switch (auth.type) {
    case "entra": {
      return entraAuth(auth)
    }
    case "mcp-oauth": {
      return mcpOAuth(auth)
    }
    case "none": {
      return noAuth()
    }
    default: {
      const unknown: { type: string } = auth
      throw new Error(`Unknown connector auth type "${unknown.type}".`)
    }
  }
}
