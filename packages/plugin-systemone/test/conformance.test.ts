/**
 * The generic plugin conformance suite
 * (`@stuffbucket/maximal-plugin-host/testing`) for the SystemOne plugin, with
 * a fake upstream provider and the operations service the app host installs.
 */
import {
  capabilityServices,
  catalogModel,
  createFakeUpstream,
  runPluginConformance,
} from "@stuffbucket/maximal-plugin-host/testing"

import * as systemone from "../src/index"

const fake = createFakeUpstream({
  models: [catalogModel("microsoft-decision-1")],
})

runPluginConformance(systemone, {
  changedConfig: {
    bindings: [
      {
        model: "microsoft-decision-1",
        provider: "copilot",
        upstreamModel: "microsoft-decision-1",
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
