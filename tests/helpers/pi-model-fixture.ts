import type { Model } from "~/services/copilot/get-models"

export function piModelFixture(id = "test-chat"): Model {
  return {
    id,
    name: id,
    object: "model",
    vendor: "test",
    version: "1",
    model_picker_enabled: true,
    preview: false,
    supported_endpoints: ["/responses"],
    capabilities: {
      family: "test",
      object: "model_capabilities",
      type: "chat",
      tokenizer: "test",
      supports: {
        tool_calls: true,
        streaming: true,
        reasoning_effort: ["low", "high"],
      },
      limits: { max_context_window_tokens: 200000, max_output_tokens: 32000 },
    },
    billing: {
      token_prices: {
        batch_size: 1000000,
        input: 200,
        output: 1000,
        cache_read: 20,
        cache_write: 0,
      },
    },
  }
}
