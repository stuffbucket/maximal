import type { RemoteMcpConnectorManifest } from "../src/manifest"

export const TERMS_URL = "https://example.com/terms"

/** A made-up Entra connector (nothing here is contacted). */
export const EXAMPLE_MANIFEST: RemoteMcpConnectorManifest = {
  id: "example",
  kind: "connector",
  displayName: "Example",
  description: "An example remote MCP connector.",
  settingsVersion: 1,
  connector: {
    transport: "streamable-http",
    endpoint: "https://mcp.example.com/mcp",
    auth: {
      type: "entra",
      clientId: "00000000-0000-4000-8000-00000000c11e",
      authority: "https://login.microsoftonline.com/organizations",
      scopes: ["api://00000000-0000-4000-8000-0000000000a1/Example.Read"],
      redirectUri: "http://localhost:12798",
    },
    terms: { url: TERMS_URL },
  },
}
