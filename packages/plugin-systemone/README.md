# @stuffbucket/maximal-plugin-systemone

`model`-kind capability plugin. It does two things with Microsoft-Decision-1
(Copilot's `microsoft-decision-1` by default, business and enterprise plans):

- Serves the `systemone` operation (`POST /v1/systemone`): the body goes to the
  bound provider unchanged, under the provider's own model id.
- Offers Claude Code a `classify` server tool (hidden, `offer: "always"`), run
  inside the `/v1/messages` loop. Input: `state` (text or JSON) and `questions`
  (an object keyed by name of `{ type: noul | choice | score, instructions,
  criteria? }`). The result is one compact text line per answer (probability,
  chosen option, or score, with confidence); errors come back as `isError`
  results. The description and schema are fixed, so they stay in the
  prompt-cache prefix. It is free on Copilot.

The tool exists only while the plugin is on, the provider is signed in and its
catalog offers the model (so not on a plan without it); `tools.classify: false`
in the plugin's config removes it. It is a server tool, not an MCP tool, so it
is not served over `/mcp/<id>`.
