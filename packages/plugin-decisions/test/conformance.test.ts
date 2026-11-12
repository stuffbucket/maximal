/**
 * The generic plugin conformance suite
 * (`@stuffbucket/maximal-plugin-host/testing`) for the decisions plugin, with
 * a fake upstream provider and the operations service the app host installs.
 */
import {
  capabilityServices,
  catalogModel,
  createFakeUpstream,
  runPluginConformance,
} from "@stuffbucket/maximal-plugin-host/testing"

import * as decisions from "../src/index"

const fake = createFakeUpstream({
  models: [catalogModel("gpt-6-luna-decisions")],
})

runPluginConformance(decisions, {
  changedConfig: {
    bindings: [
      {
        model: "gpt-6-luna-decisions",
        provider: "copilot",
        upstreamModel: "gpt-6-luna-decisions",
      },
      { model: "other", provider: "copilot", upstreamModel: "other" },
    ],
  },
  leakProbes: [
    () =>
      fake.listenerCount === 0 ?
        []
      : [`${fake.listenerCount} catalog listener(s) still subscribed`],
  ],
  harness: { extraServices: capabilityServices(fake) },
})
