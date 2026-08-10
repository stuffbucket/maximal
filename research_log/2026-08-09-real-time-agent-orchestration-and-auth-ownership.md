# Real-time agent orchestration and authentication ownership

**Date:** 2026-08-09  
**Status:** research spike; architecture recommendation, not an implementation decision

## Executive conclusion

The nine-hour coordination delay is primarily a control-plane failure. GitHub issues, scheduled workflows, and session-start configuration are being used as a message bus even though none provides durable, low-latency delivery to a running coding harness.

Maximal should not add Kafka, Redis, NATS, or Temporal for the first version. It already has the necessary local primitives:

- SQLite with WAL and migrations;
- an in-process event bus;
- a multi-subscriber live feed with reconnect snapshots;
- authenticated loopback HTTP routes;
- trace and session-affinity headers.

The smallest viable system is a durable SQLite event log and lease queue, delivered through existing live-feed infrastructure, with harness-specific adapters:

- **Claude Code:** a command `SessionStart` hook registers watched inbox paths; HTTP `FileChanged` hooks provide sub-second ingress while a turn is active; `Stop` or the next `UserPromptSubmit` delivers staged context. Idle sessions are not externally wakeable and must be treated like expired claimants.
- **GitHub Copilot CLI:** `@github/copilot-sdk` for typed session control, schema-backed `events.jsonl` for observation, and MCP for in-session coordination tools. ACP over stdio is also available.

Authentication ownership must be simplified at the same time:

- **maximal-core owns authentication mechanism, persistence, health, and wire contracts;**
- **Maximal's Electron client owns authentication presentation and sidecar supervision;**
- **maximal-electron owns no authentication behavior and enforces that neutrality in CI.**

The legacy root implementation in Maximal and duplicated client adapters are competing sources of truth. They should be deleted or consolidated after the closed-bridge decision is implemented.

## What moved in maximal-core

| Change | Status | Impact |
|---|---|---|
| PR #115, `de618101` | merged | Explicitly declares agent-run state out of core's control-plane scope. Harnesses own branch, diff, approval, and task state. Core accepts correlation headers without interpreting them. Closes #109. |
| PR #116, `4772eac8` | merged | Test isolation only: token state is reset through its owning API. No consumer behavior change. |
| PR #117, `ba0b8c17` | merged, unreleased | Publishes `AuthStatus` from the control-contract barrel and makes core's `ControlClient` send the protocol-version header on RPC, subscriptions, and REST reads. `server/discover` remains unversioned. |
| PR #118, `2050e459` | merged, unreleased | Adds `GITHUB_API_BASE`. It accepts arbitrary HTTP(S) origins and treats the selected origin as credential-bearing, with no test-only or loopback guard. |
| PR #119, `76f78349` | merged, unreleased | Logs failed Copilot token re-minting instead of silently reporting offline. Operational visibility only. |
| PR #120, head `5ec5e274` | open | Adds a real-boot regression test proving the stored GitHub token reaches neither stdout/stderr nor log files. No consumer API change. |
| PR #121, head `e61175c` | open | Requires an explicitly-set `COPILOT_API_HOME` to already exist. The client already creates its data home before spawn. |
| PR #122, head `f30ac43` | open | Refuses proxy traffic below a remote manifest's `min_supported_version`; control/auth routes remain available. This couples the bundled core version to the shared update manifest. |
| PR #123, `0bca45fa` | merged, unreleased | Makes generated declarations deterministic and marks `dist/**` non-mergeable. |
| Issue #124 | open | Containerized `bindings:check` cannot validate a linked worktree because its `.git` file points to an unmounted host path; the current command silently reports that it could not run. |

Everything after v0.6.0 remains unreleased. A merge-SHA pin is available when integration work resumes, but containerized binding checks must run from a full clone or directly on the host until #124 is fixed.

## Authentication ownership

### Authoritative responsibilities

| Responsibility | Owner |
|---|---|
| GitHub device flow and polling | maximal-core |
| Auth state machine and `AuthStatus` projection | maximal-core |
| Token store and multi-account registry | maximal-core |
| Copilot bearer mint/refresh and credential health | maximal-core |
| Control-plane authentication and origin guard | maximal-core |
| `auth/*` JSON-RPC methods and schemas | maximal-core |
| Device-flow screens, copy, countdowns, and errors | Maximal `client/` |
| Sidecar spawn, restart, and lifecycle narration | Maximal `client/` |
| Generic window, preload-extension, and renderer components | maximal-electron |

`maximal-electron` deliberately forbids dependencies on Maximal and maximal-core. Its profile components expose callbacks; they do not know the identity provider or token lifecycle.

### Current duplication

1. Maximal's root `src/lib/auth/**`, `src/services/github/**`, and related routes remain a drifted pre-extraction copy of core. They look live because they are tested and documented, but the Electron client builds an `@stuffbucket/maximal-core` sidecar instead.
2. The frozen Tauri shell and Electron client pin different generations of core.
3. The Electron client manually stamps the protocol header and performs version mismatch checks that core#117 now owns.
4. First-run and Settings maintain parallel auth capability adapters and parallel device-flow presentation scaffolding.
5. Core's published `settings-types` comment still describes an `"unknown"` login sentinel that its controller and ADR say was retired. The client faithfully implements the stale published comment.

### Adjustment

Do not move authentication into maximal-electron. Move in the opposite direction:

1. finish deleting the root Maximal auth engine;
2. make `@stuffbucket/maximal-core/control-contract` the only type-level auth contract entry point;
3. keep runtime zod schemas in `settings-types` only where boundary parsing requires them;
4. move the renderer's direct HTTP client behind the closed, typed main/preload bridge tracked by maximal#435;
5. collapse first-run and Settings onto one application adapter after that bridge exists.

## Why current coordination is slow

The observed delay is consistent with several mechanisms that compose:

- `~/.claude/settings.json` integration is discovered at session boundaries;
- no durable webhook receiver currently wakes a running agent;
- repository drift monitoring is scheduled daily;
- GitHub scheduled workflows can be delayed or dropped;
- GitHub webhooks are at-most-once: failed deliveries are not automatically retried, delivery logs persist for only three days, ordering is not guaranteed, and oversized payloads or high-volume ref/tag operations can be silently suppressed without a failed-delivery record;
- no durable claim lease, heartbeat, or reclaim loop exists;
- a delivered signal that is omitted from the next prompt is observationally identical to a lost signal.

The exact nine-hour cause has not been instrumented. The first implementation stage must record generated and observed timestamps before claiming the transport alone caused it.

## Systems compared

### Protocols

- **MCP:** tool/application protocol, not a durable queue. Current and future protocol revisions do not provide the replay and delivery guarantees Maximal needs. Harness protocol-version support must be measured rather than assumed.
- **A2A:** richer task and agent-to-agent semantics, but its messages are explicitly not a reliable channel for critical information while disconnected.
- **ACP:** useful editor-to-agent protocol, but not a cross-repository durability substrate.
- **OpenAI Responses/webhooks:** vendor-specific; webhook retries are stronger than most open agent protocols but do not solve local multi-harness ownership.

### Durable substrates

- **SQLite WAL:** best fit for one local daemon. Atomic claims, replay, idempotency, and observability can share one transaction and one database.
- **NATS JetStream:** best second-stage option for multi-process or hosted federation. It adds acknowledgements, replay, backoff, and lease extension, but requires another supervised process from Bun.
- **Redis Streams:** provides pending-entry recovery but needs explicit reclaim and dead-letter logic; licensing and durability are less attractive for this use.
- **Kafka:** operationally excessive; exactly-once guarantees do not cover external effects such as git or filesystem mutation.
- **Temporal:** strongest workflow durability and heartbeat model, but introduces a server and a workflow programming model far beyond the local MVP.

## Recommended minimal architecture

### Durable storage

Add two tables to the existing SQLite database.

`coord_events` is append-only and contains:

- monotonic event id;
- source and source event id;
- repository/worktree/session/agent identity;
- event type and version;
- payload;
- generated and observed timestamps;
- trace context.

A unique `(source, source_event_id)` key makes ingestion idempotent. GitHub supplies `X-GitHub-Delivery`; Claude Code hook payloads supply session, prompt, and tool identifiers.

`coord_tasks` contains:

- state (`READY`, `LOCKED`, `DONE`, `FAILED`);
- owner;
- monotonic `claim_id` fencing token;
- claim and lease timestamps;
- delivery count and maximum deliveries;
- outcome/error metadata.

Every heartbeat or terminal transition must present the current `claim_id`. Expired leases must be reclaimed automatically. Poison tasks terminate in `FAILED`; they must not loop forever.

### Delivery

Extend the existing live-feed discriminated union with `coord.*` events. Replay comes from `coord_events`; the live feed is only the wakeup path, not the source of truth.

### Claude Code adapter

The adapter behavior was exercised against Claude Code 2.1.226 in isolated headless sessions.

`SessionStart` must be a **command hook**. Claude Code unconditionally skips HTTP hooks for `SessionStart` and `Setup`, logging the skip only to the debug file. The command hook returns an absolute inbox path in `watchPaths`.

When another process changes that path, a matcher-less HTTP `FileChanged` hook reaches a loopback receiver in roughly 600 ms, including during an in-flight turn. This is authenticated, asynchronous harness-to-Maximal ingress.

`FileChanged` is an executor, not a context channel: it cannot inject `additionalContext`, does not interrupt the model, and does not wake an idle session. Delivery therefore works as follows:

1. command `SessionStart` registers the inbox path;
2. an external producer writes a compact marker;
3. HTTP `FileChanged` stages the corresponding durable event in Maximal;
4. `Stop` returns `decision: block` with actionable feedback and resumes an active turn, or the next `UserPromptSubmit` delivers pending context;
5. if the session is already idle, no wakeup exists—the task lease expires and another claimant may recover it.

Measured end to end in an active turn, an external write at 0.904 seconds reached the hook at 1.507 seconds, entered conversation context at 2.79 seconds, and was acted on around 6.2 seconds.

Use matcher-less `FileChanged` groups with explicit `watchPaths`: matcher values also register literal filenames under the working directory, and watch paths are reported verbatim rather than realpath-normalized.

Research-preview channels and cross-session messaging are not baseline dependencies. Channels require Anthropic-hosted authentication and may silently drop events; cross-session messaging is version-gated and its sender identity is forgeable except for the verified peer process id.

Enterprise hook allowlists and cloud sessions may prevent local HTTP hooks. A command hook can still call the authenticated loopback endpoint directly.

### GitHub Copilot CLI adapter

Copilot CLI is generally available and exposes stronger automation surfaces than MCP alone:

- `@github/copilot-sdk` provides typed JSON-RPC control of CLI sessions, tools, permissions, and elicitation callbacks;
- `--output-format json` emits schema-backed JSONL, and every session writes the same event schema to `events.jsonl`;
- `copilot --acp --stdio` exposes Agent Client Protocol;
- `--additional-mcp-config` permits per-run MCP injection without mutating persistent user configuration.

Maximal should use the SDK to launch/control sessions and ingest `events.jsonl` into the durable event log. MCP remains the in-session tool surface:

- `maximal_inbox_poll`;
- `maximal_claim`;
- `maximal_heartbeat`;
- `maximal_report`.

Workspace MCP is disabled by default in non-interactive prompt mode unless explicitly enabled. The adapter must configure this per run and must read the final JSONL `result.exitCode` rather than depending on undocumented process exit-code semantics.

## Rollout

1. **Instrument:** record generation and observation without changing delivery. Establish the actual latency distribution and distinguish missing from ignored signals.
2. **Persist:** implement append-only events, atomic claim, fencing, heartbeat, retry, terminal failure, and lease reclaim.
3. **Broadcast:** extend the existing live feed and test disconnect/reconnect recovery from SQLite.
4. **Claude ingress:** register `watchPaths` through a command `SessionStart` hook and ingest authenticated HTTP `FileChanged` payloads with provenance.
5. **Deliver at turn boundaries:** stage events on `FileChanged`, inject them through `Stop` or the next `UserPromptSubmit`, and expire idle claimants through the normal lease-reclaim path. Measure generation-to-hook and generation-to-action separately.
6. **Copilot SDK adapter:** control sessions through `@github/copilot-sdk`, ingest `events.jsonl`, and inject the Maximal MCP server per run. Verify observation survives a CLI restart.
7. **Reconcile external state:** if GitHub becomes an input, periodically compare authoritative repository state rather than treating webhook delivery logs as replay.
8. **Federate only when required:** introduce NATS JetStream if multiple daemons or hosted federation become real requirements.

## Required tests

- two concurrent claimers cannot both win;
- a stale claimant cannot complete after a newer `claim_id` is issued;
- daemon death during a claim recovers automatically within the lease threshold;
- duplicate source event ids create one event;
- poison tasks terminate after maximum deliveries;
- reconnecting clients reconstruct state from SQLite rather than relying on missed stream frames;
- hook failure does not block normal harness operation;
- an active turn receives a staged event through `Stop`, while an idle claimant is recovered only by lease expiry;
- `FileChanged` output is never treated as direct model context;
- context volume scales with actionable events, not turns;
- a sibling subagent's failure retains the sibling's provenance;
- protocol negotiation is tested against installed Claude Code and Copilot CLI clients.

## Documentation consolidation

Prioritize deletion over deprecation annotations.

1. Delete the root Maximal auth implementation after excavation is complete.
2. Correct core's stale `"unknown"` account-login contract, then remove the client workaround it created.
3. Resolve maximal#435 and commit a corrected ADR that matches shipped transport and security behavior.
4. Remove false ADR claims that Tauri was moved to `platform/tauri` or that still-present ADRs were deleted.
5. Replace Maximal copies of core-owned auth and wire documentation with short pointers to core.
6. Delete shell-only ADRs and Tauri follow-ups from core where core cannot act on them.
7. Resolve the duplicate ADR-0018 identifier.
8. Delete the untracked `docs/maximal-core-integration.md` if its package and transport assumptions remain superseded.

## Sources

Primary sources used in the spike:

- [Claude Code hooks](https://code.claude.com/docs/en/hooks)
- [Claude Code hooks guide](https://code.claude.com/docs/en/hooks-guide)
- [GitHub Copilot CLI MCP configuration](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers)
- [GitHub Copilot CLI reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference)
- [GitHub Copilot CLI GA announcement](https://github.blog/changelog/2026-02-25-github-copilot-cli-is-now-generally-available)
- [GitHub webhook troubleshooting](https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/troubleshooting-webhooks)
- [GitHub failed webhook deliveries](https://docs.github.com/en/webhooks/using-webhooks/handling-failed-webhook-deliveries)
- [GitHub webhook delivery retention](https://github.blog/changelog/2023-10-17-webhook-delivery-logs-will-only-be-retained-for-3-days)
- [MCP specifications and versioning](https://modelcontextprotocol.io/specification/versioning)
- [A2A specification](https://a2a-protocol.org/latest/specification/)
- [Agent Client Protocol](https://agentclientprotocol.com/)
- [NATS JetStream](https://docs.nats.io/nats-concepts/jetstream)
- [Redis Streams](https://redis.io/docs/latest/develop/data-types/streams/)
- [Temporal failure detection](https://docs.temporal.io/encyclopedia/detecting-activity-failures)
- [SQLite WAL](https://www.sqlite.org/wal.html)
- [Transactional outbox pattern](https://microservices.io/patterns/data/transactional-outbox.html)
- [GitHub webhook best practices](https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks)
- [MAST failure taxonomy](https://arxiv.org/abs/2503.13657)
- [Cognition: Don't Build Multi-Agents](https://cognition.com/blog/dont-build-multi-agents)
- [Anthropic multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)
