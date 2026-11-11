/**
 * The generic plugin conformance suite (`@stuffbucket/maximal-plugin-host/testing`)
 * for Work IQ: the shipped module as is (Entra, nothing signed in, no
 * network), and an instance wired to the fake Work IQ upstream with a
 * signed-in fake account, so the checks also cover mirrored tools and the
 * upstream sessions closing.
 */
import { runPluginConformance } from "@stuffbucket/maximal-plugin-host/testing"
import { afterAll, beforeAll } from "bun:test"

import * as workiq from "../src/index"
import {
  BENCH_ACCOUNT,
  fakeAuth,
  type FakeRemoteMcp,
  startFakeWorkIq,
} from "../src/testing"

runPluginConformance(workiq, {
  changedConfig: { authority: "https://login.microsoft.com/organizations" },
})

let fake: FakeRemoteMcp
beforeAll(() => {
  fake = startFakeWorkIq()
})
afterAll(async () => {
  await fake.close()
})

runPluginConformance(
  () =>
    workiq.createWorkIqPlugin({
      endpoint: fake.url,
      auth: fakeAuth({ account: BENCH_ACCOUNT, signedIn: true }),
    }),
  {
    title: "plugin conformance: workiq (fake upstream, signed in)",
    storage: {
      "terms.json": JSON.stringify({ accepted: true, terms: workiq.TERMS_URL }),
    },
    settled: (harness, id) => harness.snapshot(id).status?.code === "ready",
    expectTools: true,
    changedConfig: { authority: "https://login.microsoft.com/organizations" },
    leakProbes: [
      () =>
        fake.sessionCount === 0 ?
          []
        : [`${fake.sessionCount} upstream MCP session(s) still open`],
    ],
  },
)
