# Observability via OpenTelemetry + SigNoz — PRD

Status: Proposed (not scheduled), 2026-05-04.
Owner: bstucker.
Scope: Local-first observability stack for the proxy and the Claude
clients that connect through it. OpenTelemetry on both sides, MIT-
licensed dashboard, all running on the user's machine. Deferred
until one of the listed triggers fires — this PRD exists so the
design decisions are recorded ahead of time, not so the work is
imminent.

## TL;DR

- The user-facing questions ("how many sessions are active", "which
  session is waiting", "how full is each context window") are
  answerable from a few well-tagged spans plus a small number of
  metrics, but only if the proxy actually emits them.
- Cheap path: stand up SigNoz + OTel Collector via docker-compose,
  instrument the proxy with the OTel SDK, point Claude Desktop at the
  same collector. Single half-day of work for a useful dashboard.
- The existing `/usage-viewer` page is "useful in theory but not in
  practice" — this stack subsumes what it does, but doesn't require
  removing it.
- Deferred (not scheduled) because there's no pain right now. The
  cleanup-PRD work (M1–M6) already answers the cold-debugging cases
  via `copilot-api debug` and `/_debug/state`. Observability is the
  next layer up: history, search, correlation across sessions.

## Problem

After the M1–M6 cleanup the proxy can answer "what's my current
state?" in one command. What it still can't answer:

1. **What's been happening over time?** No history, no aggregation. A
   "context is full" event is a single log line; there's no way to
   ask "how often does this happen, and which models trigger it
   most?"
2. **Which sessions are doing what?** The daily log groups by trace
   ID per request, not by session. Cross-request session activity
   requires hand-grepping.
3. **How full are context windows in flight?** Each request carries
   `usage.input_tokens` but it's never compared against the model's
   max-context. The "you're about to compact" signal is invisible
   until it happens.
4. **Are subagents pulling their weight?** The `__SUBAGENT_MARKER__`
   detection tags requests internally but no one ever reads the
   distribution.
5. **Claude Desktop emits OTel telemetry already.** That data lands
   nowhere by default. Collecting it costs almost nothing if a
   collector is running anyway, even if the dashboards come later.

## Goals

| Goal | Acceptance signal |
|---|---|
| Local stack starts in one command | `docker compose up signoz` brings up dashboard + collector + ClickHouse, browser at `localhost:3301` |
| Proxy emits semantic spans + metrics | Every `/v1/messages` request creates a parent span with `claude.session_id`, `claude.model`, `claude.subagent`, `claude.input_tokens`, `claude.context_used_pct` |
| Claude Desktop's own OTel exports land in the same pipeline | Both sources visible in the SigNoz trace explorer; `traceparent` propagates from client into proxy spans |
| User's five specific questions are answerable from a dashboard | "Active sessions / subagent count / context fullness / session activity / sessions idle" — each as a panel |
| MIT-licensed end to end | SigNoz (MIT), OTel Collector (Apache 2.0 — kept since it's industry standard, not a UI), proxy SDK code (MIT) |
| Doesn't replace existing diagnostics | `copilot-api debug`, `/_debug/state`, daily logs all remain functional and authoritative for cold inspection |

## Non-goals

- **Production-grade SRE alerting.** This is a personal/team-of-few
  observability stack. PagerDuty integration, escalation policies,
  SLO definitions are out.
- **Multi-tenant data isolation.** Single user, single proxy, single
  ClickHouse. If the proxy ever serves multiple users this PRD
  needs revisiting alongside the deferred `RuntimeContext` refactor.
- **Hosted backend.** The point is local. Grafana Cloud / Honeycomb /
  Datadog are explicitly out — they're fine paths but not what this
  PRD scopes.
- **Replacing `copilot-api debug` or `/_debug/state`.** Those answer
  "right now" questions in one command; observability adds history
  on top, not as a replacement.
- **Replacing the daily log.** Logs stay; logs are the source of
  truth for compliance / forensics. Bridging logs into the
  observability stack is a separate (deferred) item.
- **Replacing `/usage-viewer`.** Leave it; link out from README.

## Scope: in this milestone

Three additive commits + a small docs page. Each independently
mergeable, ordered to make each commit individually demoable.

### O1. `feat(observability): docker-compose for SigNoz + OTel Collector`

**Change:** add a `signoz` profile to `docker-compose.yml` (or a
sibling `docker-compose.observability.yml`) that brings up:

- SigNoz frontend + query-service (one container each)
- ClickHouse (their default config)
- OTel Collector with a minimal config: OTLP/HTTP and OTLP/gRPC
  receivers, ClickHouse exporter to SigNoz

Plus `scripts/install-claude-otel.sh` (modeled on
`install-cowork-egress.sh`) that sets the relevant Claude Desktop env
vars / plist keys to point at the local collector.

**Acceptance:**
- `docker compose --profile signoz up -d` starts five services and
  exits with all healthy.
- Browser at `http://localhost:3301` shows the SigNoz UI.
- `curl localhost:4318/v1/traces` (the collector) returns 200 for a
  valid OTLP payload, 4xx for malformed.
- `scripts/install-claude-otel.sh` is idempotent and `defaults read`
  shows the expected keys after running.

**Estimate:** ~150 LOC of compose + collector YAML + the install
script.

### O2. `feat(observability): instrument proxy with OpenTelemetry`

**Change:** wire the OTel SDK into the proxy startup path. Two layers:

- **Auto-instrumentation** for `http`, `fetch` via
  `@opentelemetry/auto-instrumentations-node`. Free coverage of every
  inbound request and every outbound Copilot/Ollama call.
- **Manual spans** at the natural boundaries:
  - `messages.handle` — root span per `/v1/messages` request
  - `web_tools.agent` / `web_tools.stream` — per agent loop
  - `web_tools.turn` — per turn
  - `web_tools.execute` — per tool call (search/fetch)

**Manual metrics:**
- Counters: `claude.requests_total`, `claude.tokens_total`,
  `claude.web_tools.outcomes`, `claude.cache.{hits,misses,evictions}`
- Histograms: `claude.context_used_ratio` (input_tokens /
  model_max_context, bucketed by model)
- Gauges (via `ObservableGauge`): bridge `allCacheMetrics()` so cache
  state polls into the observability layer for free

**Span attributes** on the request span:
- `claude.session_id` (from `getRootSessionId`)
- `claude.subagent` (boolean from subagent-marker detector)
- `claude.model` (post-rewrite)
- `claude.compact_type` (if compacting)
- `claude.input_tokens`, `claude.output_tokens`,
  `claude.context_used_pct`, `claude.context_max`
- `claude.tool_use_count`

**Cardinality discipline:** `session_id` is a span attribute (high
cardinality, fine for traces) but **never** a metric label.

**Trace context propagation:** Hono middleware extracts `traceparent`
from incoming requests so Claude Desktop's traces correlate with
proxy spans. Outgoing Copilot calls already get the headers via
auto-instrumentation.

**Configuration:**
- New env var: `OTEL_EXPORTER_OTLP_ENDPOINT` (default unset; when
  unset, OTel SDK is a no-op — zero cost when observability isn't
  running).
- Optional: `OTEL_SERVICE_NAME` (defaults to `copilot-api`).
- Logged at startup alongside the existing executor banner.

**Acceptance:**
- With the stack from O1 running, every `/v1/messages` request
  creates a span visible in SigNoz within 2s.
- The five specific user questions resolve to concrete queries:
  1. **Active sessions** = `count_distinct(claude.session_id)` over
     last N minutes
  2. **Subagent count** = `count` filtered by
     `claude.subagent=true` over last N
  3. **Context fullness** = histogram of `claude.context_used_ratio`
     by `claude.model`
  4. **Session activity** = trace explorer filtered by
     `claude.session_id`
  5. **Sessions waiting** = `(now - max(timestamp) by claude.session_id) > X`
- With `OTEL_EXPORTER_OTLP_ENDPOINT` unset, `bun test` and `bun
  start` are unchanged in behavior — no leftover async work, no
  network calls.

**Estimate:** ~250 LOC across `src/lib/otel.ts` (init), `src/server.ts`
(middleware), `src/routes/messages/handler.ts` (root span attrs),
`src/routes/messages/web-tools-{agent,stream}.ts` (web-tools spans).
Plus tests for the metric-emission paths.

### O3. `feat(observability): default dashboards`

**Change:** export three SigNoz dashboards as JSON, committed to
`docs/observability/dashboards/`. Loaded via SigNoz's import UI on
first run, or auto-provisioned if their compose supports it.

**Three dashboards:**

| Dashboard | Panels | Audience |
|---|---|---|
| **Overview** | RPS by endpoint; p50/p95/p99 latency; error rate; current active sessions; subagent share; cache hit rate | "is the proxy healthy" |
| **Sessions** | Per-session activity (table sorted by last_seen); session model mix; sessions idle > N min; time-to-first-token by session | "what is each user / agent doing" |
| **Context engineering** | `context_used_pct` heatmap by model; histogram of input_tokens; compaction rate; web-tools turns distribution; tokens-per-tool-call | "where is the context budget going" |

**Acceptance:** importing the JSON in a fresh SigNoz install
produces three working dashboards with no manual configuration.

**Estimate:** ~half-day of dashboard authoring + tuning. The JSON
files are large (hundreds of lines each) but generated by SigNoz's
export.

### O4. `docs: observability admin guide`

**Change:** new `docs/admin/observability.md` covering:
- How to start the stack (`docker compose --profile signoz up`)
- How to configure Claude Desktop OTel exports
- How to enable proxy instrumentation (`OTEL_EXPORTER_OTLP_ENDPOINT`)
- What each dashboard shows + how to interpret it
- Cardinality and retention notes (ClickHouse defaults; how to tune)

**Estimate:** documentation-only. ~80 lines.

## Scope: deferred

| Item | Defer reason | Trigger to revisit |
|---|---|---|
| Tail sampling in the collector (drop boring traces, keep slow / error) | Default sampling is fine at single-user volume; complexity isn't paid for yet | Storage growth becomes a problem (>1 GB/day) or trace volume drowns out signal |
| Alerting / notification routing | Personal stack, no on-call rotation | Multiple operators using the same proxy |
| Bridging the daily log into Loki / SigNoz logs | Logs are already structured and grep-friendly; double-storing is cost without payoff | Log search across days becomes a routine task |
| Replacing `/usage-viewer` | The dashboard subsumes its function, but removing the existing endpoint is a separate decision | Confirmed nobody uses `/usage-viewer` |
| Trace context propagation from Claude Code (the CLI, not Desktop) | CLI doesn't currently emit OTel; would need to instrument it ourselves | Claude Code adds OTel support upstream |
| Multi-host setup (collector on a different machine) | Single-machine is the point | Proxy moves to a shared host |
| Switching backend (Tempo + Mimir + Loki + Grafana) | SigNoz is the simpler MIT path | If SigNoz becomes neglected or licensing changes |
| Log redaction processor in the collector | Span attributes are deliberately limited to non-secret values; not a current risk | A regression accidentally puts a token / key on a span |
| Hosted-backend alternative (Grafana Cloud, Honeycomb, Azure Monitor) | Stated non-goal | If the user wants observability without the local-stack burden |

## Risks

- **ClickHouse footprint.** ~500 MB RAM, ~1 GB disk to start, grows
  with retention. Acceptable on a developer Mac but not free.
  Mitigation: SigNoz's default retention is 15 days for traces, 30
  for metrics — adequate without tuning. Document the tunables in
  the admin guide.
- **Cardinality blow-up.** Putting `session_id` or `request_id` on
  metric labels is the classic mistake. Mitigation: per-attribute
  rule documented in O2; lint check possible later (custom rule:
  `metric.attribute.session_id` is forbidden).
- **OTel SDK init order.** Auto-instrumentation must run before any
  module that imports `http` / `fetch`. In Bun's ESM, this means the
  init has to happen at the very top of `src/main.ts` before other
  imports — easy to break with a future refactor. Mitigation:
  `src/lib/otel.ts` init runs in a side-effect import at the top of
  `main.ts`, with an inline comment guarding the order.
- **Bun ↔ OTel SDK compatibility.** OTel's Node SDK has historically
  trailed Bun support by a release or two. Mitigation: pin to a known-
  working version, validate before committing. If Bun breaks the
  SDK, fall back to OpenTelemetry's HTTP-only exporter (no
  auto-instrumentation) — coverage drops but nothing else.
- **Claude Desktop OTel surface drift.** Anthropic could change
  what they emit between releases; dashboards built against
  `claude_desktop.*` attributes might break. Mitigation: dashboards
  are committed JSON — easy to fix forward. Don't build alerts on
  Claude Desktop attributes (the proxy's own attributes are stable
  because we own them).
- **`OTEL_EXPORTER_OTLP_ENDPOINT` without a running collector.**
  When the env is set but the collector is down, the SDK retries and
  buffers. Mitigation: SDK config sets a tight `BatchSpanProcessor`
  timeout and bounded queue so a stalled collector doesn't leak
  memory in the proxy.
- **`copilot-api debug` already covers the static questions.**
  Risk that this milestone adds operational burden (a docker stack)
  for marginal value. Mitigation: keep the SDK behavior gated on the
  env var; running the proxy with no observability is identical to
  today.

## Success criteria

End-to-end test for the originating motivation:

```
$ docker compose --profile signoz up -d
$ scripts/install-claude-otel.sh
$ OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 copilot-api start
$ open http://localhost:3301

# In the SigNoz UI:
#   1. Active sessions panel shows 1 (this terminal)
#   2. After running Claude Code, claude.session_id appears
#   3. After running Claude Desktop with Cowork, a second session appears
#   4. Context fullness panel shows a per-model histogram with real data
#   5. Sessions panel reveals which one is currently waiting on a tool result
```

If a future user can answer all five from one dashboard load, the
milestone delivered.

## Sequencing notes

O1 → O2 → O3 → O4. O2 depends on O1 being up so spans have
somewhere to land for tests. O3 depends on O2 producing the right
attributes. O4 wraps up.

If only one commit lands: skip — partial work here is worse than
nothing because instrumentation without dashboards is invisible.
The whole stack should land together or not at all.

## Trigger to schedule

This PRD is intentionally not scheduled. Pick it up when one of:

- A user asks "what was Claude Desktop doing yesterday at 3pm" and we
  can't answer
- The cleanup PRD's deferred `RuntimeContext` work gets picked up
  (multi-session needs make observability a hard prerequisite)
- A regression slips through that would have been caught by trace
  history
- Someone wants to study context-window utilization across models
  empirically (the O3 dashboards are the cheapest way to do this)

Until then: cold-debugging via `copilot-api debug` and the daily log
is sufficient.

## Out of scope (this PRD)

- Web-tools work — covered by `docs/spec/web-tools.md`
- Tool-bridge work — covered by `docs/spec/tool-bridge.md`
- State / config / cache cleanup — covered by
  `docs/spec/state-config-cache-cleanup.md` (now closed)
- MDM / egress — covered by `docs/admin/claude-desktop-mdm.md`

## References

- SigNoz: https://github.com/SigNoz/signoz (MIT)
- OpenTelemetry JS: https://github.com/open-telemetry/opentelemetry-js (Apache 2.0)
- Auto-instrumentation: https://github.com/open-telemetry/opentelemetry-js-contrib (Apache 2.0)
- Hono OTel middleware:
  https://github.com/honojs/middleware/tree/main/packages/otel
- Claude Desktop OTel surface:
  https://docs.anthropic.com/en/docs/claude-code/monitoring-usage
  (the same env-var-driven exporter is reused by Claude Desktop)
