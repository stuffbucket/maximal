/**
 * The generic plugin conformance suite
 * (`@stuffbucket/maximal-plugin-host/testing`) for the images plugin, with a
 * fake upstream provider and the operations service the app host installs.
 */
import {
  capabilityServices,
  catalogModel,
  createFakeUpstream,
  runPluginConformance,
} from "@stuffbucket/maximal-plugin-host/testing"

import * as images from "../src/index"

const fake = createFakeUpstream({
  models: [catalogModel("gpt-image-2.5-flare", "image")],
})

runPluginConformance(images, {
  changedConfig: {
    bindings: [
      {
        model: "gpt-image-2.5-flare",
        provider: "copilot",
        upstreamModel: "gpt-image-2.5-flare",
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
