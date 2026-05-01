# contrib/

Read-only reference snapshots from related upstream projects. **Nothing in
this directory is built or shipped** — it's documentation that informed
the architecture. The live code lives in `vendor/copilot-api/`.

## Why these are kept

The proxy in `vendor/copilot-api/` is vendored from
[caozhiyuan/copilot-api](https://github.com/caozhiyuan/copilot-api). When
Copilot's API changes or quirks emerge, these references give us
secondary implementations to diff against:

- **Different translation of the same Anthropic surface** (ollama)
- **Different Copilot auth implementation** (opencode)
- **The fork lineage** caozhiyuan came from (ericc-ch)

## Directory map

### copilot-api-ericc/

[ericc-ch/copilot-api](https://github.com/ericc-ch/copilot-api) (MIT,
last push 2025-11-10, ~6 months stale). The original fork that
caozhiyuan continued. Smaller surface area than caozhiyuan; useful for
seeing which features are upstream-original vs. caozhiyuan additions.
Reach for this when isolating which behavior to attribute to which
maintainer.

### opencode-copilot/

How [sst/opencode](https://github.com/sst/opencode) does Copilot auth.

- `auth.ts` (115 lines, verbatim from
  [sst/opencode-github-copilot](https://github.com/sst/opencode-github-copilot)).
  Clean, self-contained `AuthCopilot` namespace: device-flow authorize,
  poll-for-access-token, exchange-for-Copilot-token, refresh.
- `opencode-copilot-auth.index.mjs` — the bundled plugin from
  [sst/opencode-copilot-auth](https://github.com/sst/opencode-copilot-auth)
  that opencode loads at runtime. Includes the GHE `enterpriseUrl`
  handling pattern.
- `LICENSE` — MIT.

opencode is officially blessed by GitHub for Copilot integration
(GitHub Changelog 2026-01-16), so its auth flow is the most-validated
public reference. Use this as the **bug-fix oracle** when caozhiyuan's
auth misbehaves: diff against this and bring fixes back across.

### ollama-anthropic/

Salient parts of [ollama/ollama](https://github.com/ollama/ollama)
(MIT) showing how Ollama exposes an Anthropic-compatible endpoint.

- `anthropic/anthropic.go`, `anthropic/trace.go` — Anthropic types and
  translation to ollama's internal chat format.
- `middleware/anthropic.go` — `/v1/messages` route, SSE, tool use,
  stop reasons.
- `docs/anthropic-compatibility.mdx` — what Anthropic surface is
  supported.
- `docs/claude-code.mdx` — how to point Claude Code at an
  Anthropic-compatible server.

Translation logic targets ollama's chat format (not OpenAI), so it's
not directly portable. Keep it as a **wire-format spec** — when there's
ambiguity about what Claude Code expects on the wire, this is a second
implementation we can cross-check against.

## Refresh procedure

These are point-in-time snapshots. To update one:

```sh
# example: refresh opencode-copilot
git clone --depth 1 https://github.com/sst/opencode-github-copilot /tmp/x
cp /tmp/x/auth.ts contrib/opencode-copilot/auth.ts
git diff contrib/opencode-copilot/   # review, commit if reasonable
```
