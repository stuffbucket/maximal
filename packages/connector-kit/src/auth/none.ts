import type { AuthStrategy } from "./token-provider"

/** A public MCP server: no sign-in, no `Authorization` header. */
export function noAuth(): AuthStrategy {
  return {
    type: "none",
    interactive: false,
    create: () => ({
      account: () => Promise.resolve(undefined),
      getToken: () => Promise.resolve(undefined),
      signIn: () => Promise.resolve({}),
      signOut: () => Promise.resolve(),
    }),
  }
}
