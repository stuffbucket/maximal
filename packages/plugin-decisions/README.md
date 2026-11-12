# @stuffbucket/maximal-plugin-decisions

`model`-kind capability plugin. It does two things with the Decisions API
(Copilot's `gpt-6-luna-decisions` by default):

- Serves the `decisions` operation (`POST /v1/decisions`): the body goes to the
  bound provider unchanged, under the provider's own model id.
- Offers Claude Code a `decide` server tool (hidden, `offer: "always"`), run
  inside the `/v1/messages` loop. Input: `input` (the evidence, a string) and
  `questions` (1 to 50 of `{ type: predicate | choice | score, name,
  instructions, choices?, levels? }`; `name` is required because Copilot rejects
  unnamed questions). The result is one compact text line per answer
  (probability, chosen option, or score, with confidence); errors come back as
  `isError` results. The description and schema are fixed, so they stay in the
  prompt-cache prefix. It is free on Copilot.

The tool exists only while the plugin is on, the provider is signed in and its
catalog offers the model; `tools.decide: false` in the plugin's config removes
it. It is a server tool, not an MCP tool, so it is not served over `/mcp/<id>`.
