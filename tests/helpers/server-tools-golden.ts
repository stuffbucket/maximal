import { messageStart } from "./server-tools-loop"

// Golden SSE transcripts: what the client reads, as (event, data) pairs.

function textEvents(index: number, text: string) {
  return [
    {
      event: "content_block_start",
      data: {
        type: "content_block_start",
        index,
        content_block: { type: "text", text: "" },
      },
    },
    {
      event: "content_block_delta",
      data: {
        type: "content_block_delta",
        index,
        delta: { type: "text_delta", text },
      },
    },
    {
      event: "content_block_stop",
      data: { type: "content_block_stop", index },
    },
  ]
}

function terminal(usage: Record<string, number>) {
  return [
    {
      event: "message_delta",
      data: {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage,
      },
    },
    { event: "message_stop", data: { type: "message_stop" } },
  ]
}

/**
 * `callTurn` then `answerTurn` with a hidden `decide` call between: the text
 * before the call streams, the call and its result never do (the next turn's
 * text takes index 1), and one terminal pair carries both turns' usage.
 */
export const HIDDEN_GOLDEN = [
  {
    event: "message_start",
    data: messageStart("msg_1", {
      input_tokens: 100,
      output_tokens: 1,
      cache_read_input_tokens: 80,
    }),
  },
  ...textEvents(0, "Let me check. "),
  ...textEvents(1, "Option B."),
  ...terminal({
    input_tokens: 250,
    output_tokens: 25,
    cache_read_input_tokens: 200,
  }),
]

function encrypted(url: string, title: string): string {
  return Buffer.from(
    JSON.stringify({ url, title, page_age: null }),
    "utf8",
  ).toString("base64")
}

function searchHit(url: string, title: string) {
  return {
    type: "web_search_result",
    url,
    title,
    encrypted_content: encrypted(url, title),
    page_age: null,
  }
}

/**
 * A `web_search` call (the fake executor returns two hits): rendered as
 * `server_tool_use` and a `web_search_tool_result`, each with its own client
 * index, then the next turn's text at index 3.
 */
export const NATIVE_SEARCH_GOLDEN = [
  {
    event: "message_start",
    data: messageStart("msg_1", { input_tokens: 100, output_tokens: 1 }),
  },
  ...textEvents(0, "Searching. "),
  {
    event: "content_block_start",
    data: {
      type: "content_block_start",
      index: 1,
      content_block: {
        type: "server_tool_use",
        id: "toolu_1",
        name: "web_search",
        input: {},
      },
    },
  },
  {
    event: "content_block_delta",
    data: {
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: '{"query":"shannon"}' },
    },
  },
  {
    event: "content_block_stop",
    data: { type: "content_block_stop", index: 1 },
  },
  {
    event: "content_block_start",
    data: {
      type: "content_block_start",
      index: 2,
      content_block: {
        type: "web_search_tool_result",
        tool_use_id: "toolu_1",
        content: [
          searchHit("https://example.com/a", "A"),
          searchHit("https://example.com/b", "B"),
        ],
      },
    },
  },
  {
    event: "content_block_stop",
    data: { type: "content_block_stop", index: 2 },
  },
  ...textEvents(3, "Claude Shannon."),
  ...terminal({ input_tokens: 250, output_tokens: 25 }),
]
