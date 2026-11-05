/**
 * `@stuffbucket/maximal-plugin-workiq/testing` — the Work IQ bench fixture:
 * a fake Work IQ MCP server seeded with the 14 Claude Desktop tools (12
 * captured + 2 synthetic) and canned fake answers, plus the kit's fake
 * sign-in. Use with `createWorkIqPlugin({ endpoint: fake.url, auth: fakeAuth() })`.
 */
import {
  startFakeRemoteMcp,
  type FakeRemoteMcp,
  type FakeRemoteMcpOptions,
} from "@stuffbucket/maximal-connector-kit/testing"

import { WORKIQ_RESULTS } from "./results"
import { WORKIQ_TOOLS } from "./tools"

export { WORKIQ_RESULTS } from "./results"
export { SYNTHETIC_TOOL_NAMES, WORKIQ_TOOLS } from "./tools"
export {
  ADA,
  elicitForm,
  fakeAuth,
  type FakeAuthOptions,
  type FakeRemoteMcp,
  FakeTokenProvider,
  notifyProgress,
  type RecordedRequest,
} from "@stuffbucket/maximal-connector-kit/testing"

/** The account the bench signs in as. */
export const BENCH_ACCOUNT = {
  username: "bench@contoso.com",
  name: "Bench User",
}

/** Start a fake Work IQ: the fixture tools and canned results on a loopback MCP server. */
export function startFakeWorkIq(
  options: FakeRemoteMcpOptions = {},
): FakeRemoteMcp {
  return startFakeRemoteMcp({
    name: "fake-workiq",
    tools: WORKIQ_TOOLS,
    results: WORKIQ_RESULTS,
    ...options,
  })
}
