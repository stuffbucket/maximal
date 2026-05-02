# Notice

## Project lineage

Forked from [caozhiyuan/copilot-api](https://github.com/caozhiyuan/copilot-api)
on 2026-05-01 at commit `6db9538` (version 1.9.2, branch `dev`).
caozhiyuan's project was itself a continuation of
[ericc-ch/copilot-api](https://github.com/ericc-ch/copilot-api) after
the original went unmaintained.

Inherited code is © Erick Christian Purwanto, Cao Zhiyuan, and the
contributors listed in upstream's git history. Our additions are
released under the same MIT license — see `LICENSE`.

## Our additions on top of caozhiyuan

- `src/routes/messages/web-tools-*.ts` — server-side `web_search` /
  `web_fetch` agent loop that strips Anthropic's server-side tool
  declarations, substitutes client-side shims, drives multi-turn
  Copilot calls, and synthesizes the Anthropic-shaped result blocks
  (streaming + non-streaming).
- `src/lib/anthropic-id-rewrite.ts` — dash-date sentinel rewrite of
  Claude-family model IDs so Claude Desktop's picker keeps minor
  versions distinct; reverse-mapping in the request path; variant
  routing via `output_config.effort` and the
  `anthropic-beta: context-1m-2025-08-07` header.
- `src/routes/models/route.ts` modifications — variant ids dropped
  from the listing (one canonical entry per family.major.minor).
- `src/routes/messages/handler.ts` and sibling handlers — wire the
  reverse-id and web-tools-flow dispatch into the request pipeline.
- `src/start.ts` — log the selected web-tools executor at startup.
- `docs/`, `scripts/`, `contrib/` — operator and reference content.

Specs that drove these additions: `docs/spec/web-tools.md`,
`docs/spec/tool-bridge.md`.

## Pulling from upstream

```sh
git remote add upstream https://github.com/caozhiyuan/copilot-api    # one-time
git fetch upstream
git merge upstream/dev    # or: git merge v1.9.4 (pin to a tag)
```

Conflicts most likely surface in `src/routes/messages/handler.ts`
(we modified the dispatch around request-id resolution),
`src/routes/models/route.ts` (we filter variants), and `src/start.ts`
(we log executor choice). Our `web-tools-*` and `anthropic-id-rewrite`
modules are net-new files and should merge clean.

Verify after merging:

```sh
bun install
bun run typecheck && bun run lint && bun test && bun run build
```

## Reference sources

`contrib/` holds read-only snapshots that informed the architecture
(opencode's Copilot auth pattern, an ollama-anthropic translation
spike). Nothing in `contrib/` is built or shipped.
