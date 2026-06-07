# Notice

This file documents what's net-new on top of the upstream baseline
and how to keep merging from upstream cleanly. For project lineage
and license attribution, see `THIRD-PARTY-LICENSE`.

## Our additions on top of upstream

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
- `docs/`, `scripts/` — operator and reference content.
- `src/lib/cache.ts`, `src/lib/secrets.ts`, `src/lib/config-schema.ts`,
  `src/lib/version.ts`, `src/routes/debug/route.ts` — observability
  layer (zod-validated config, secrets file loader, cache + singleton
  metrics, /_debug/state route, source-revision exposure). Drove the
  `state-config-cache-cleanup` PRD.

Specs that drove these additions: `docs/spec/archive/web-tools.md`,
`docs/spec/tool-bridge.md`, `docs/spec/archive/state-config-cache-cleanup.md`,
`docs/spec/archive/internal-distribution.md`.

## Pulling from upstream

The upstream remote is set in your local clone, not in this repo's
config. See `THIRD-PARTY-LICENSE` for upstream identity and lineage.

```sh
git remote add upstream <upstream-url>    # one-time
git fetch upstream
git merge upstream/dev                    # or: git merge <tag>
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
