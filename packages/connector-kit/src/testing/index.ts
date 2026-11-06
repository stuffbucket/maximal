export { resetSealedCacheScopes } from "../auth/sealed-cache"
export { FakeClock } from "./clock"
/**
 * `@stuffbucket/maximal-connector-kit/testing` — a fake remote MCP server
 * (with an optional fake OAuth authorization server) and a fake sign-in
 * strategy, for connector tests and the connectors bench. No real network.
 */
export {
  ADA,
  fakeAuth,
  type FakeAuthOptions,
  FakeTokenProvider,
} from "./fake-auth"
export {
  type CannedResult,
  elicitForm,
  type FakeOAuthOptions,
  type FakeRateLimit,
  type FakeRemoteMcp,
  type FakeRemoteMcpOptions,
  type FakeThrottle,
  type FakeToolHandler,
  type InjectedFailure,
  notifyProgress,
  type OAuthRecord,
  type RecordedRequest,
  SAMPLE_TOOLS,
  startFakeRemoteMcp,
} from "./fake-server"
export { memorySecretStore, type MemorySecretStore } from "./secret-store"
export type { Tool as FakeTool } from "@modelcontextprotocol/server"
