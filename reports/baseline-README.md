# Baseline measurement harness

`scripts/dev/measure-baseline.ts` quantifies the improvement from three
upcoming workstreams by capturing a before/after snapshot against a running,
authenticated proxy. Run it before a workstream lands and again after; diff the
two `reports/baseline-<label>.json` files.

## How to run

```sh
# Terminal A — start the proxy from source (needs GitHub Copilot auth):
bun run dev -- start --port 4141

# Terminal B — capture a snapshot:
bun run measure:baseline -- --label before
# …later, after a workstream lands:
bun run measure:baseline -- --label after
```

Flags / env:

| Flag | Env | Default | Purpose |
|---|---|---|---|
| `--label <name>` | — | `unlabeled` | Names the report file `reports/baseline-<name>.json` |
| `--base-url <url>` | `MAXIMAL_BASE_URL` | `http://127.0.0.1:4141` | Proxy origin |
| `--model <id>` | `MAXIMAL_MEASURE_MODEL` | `gpt-5-mini` | GPT `/responses` model for the caching probe |
| `--cache-gap-ms <n>` | — | `3000` | Wait between the two caching requests |

If no live proxy is reachable, the harness prints the guidance above, writes a
`proxy_reachable: false` report, and exits non-zero — it never fabricates
numbers.

## What each metric means (and the baseline as of harness v1)

The baseline below was captured live on 2026-07-06 against a proxy at commit
`7856b665` (`reports/baseline-before.json`). Latency figures are environment- and
load-dependent — the *shape* (warmup round-trips upstream; cost not surfaced;
cache reuse only on a fast repeat) is the durable baseline, not the exact ms.

### (2) Billing / cost visibility — `total_nano_aiu`

- **Signal:** does the `GET /token-usage` summary expose `totals.total_nano_aiu`?
- **Code today:** Copilot's per-request cost *is* captured — persisted in the
  store (`src/lib/token-usage/store.ts`, column `total_nano_aiu`) and summed by
  the summary/by-model queries (store.ts ~L541/L559). But the running proxy's
  summary JSON **omits the field**, and the dashboard
  (`shell/ui/dashboard/main.js`) renders token counts only (`input_tokens`,
  `output_tokens`, `cache_read_input_tokens`, `total_tokens`, `request_count`) —
  never cost.
- **Baseline result:** `fieldPresent: false`, `captured: false`. Cost is
  captured internally but **NOT surfaced** by the API or UI.
- **After workstream (2):** expect `fieldPresent` (and, given real traffic,
  `captured`) to flip `true`, and a cost figure to appear in the dashboard.

### (3) Warmup short-circuit — round-trip latency

- **Signal:** total round-trip latency of a Claude Code "Warmup" request
  (single user message text exactly `"Warmup"`, no tools, `max_tokens: 1`,
  `anthropic-beta` set).
- **Code today:** `src/routes/messages/handler.ts:86` forces the request onto
  the small model when `anthropic-beta` is set, there are no tools, and it is
  not a compact request. The small model is `gpt-5-mini` (`src/lib/config.ts`),
  so the warmup **round-trips to gpt-5-mini upstream**.
- **Baseline result:** median ≈ **4.7 s** (samples 3.3–16.4 s; the first
  request pays cold-start), `resolved_model: gpt-5-mini-2025-08-07` — confirming
  the upstream round-trip.
- **After workstream (3):** a canned local response should drop this to
  near-zero (single-digit ms) and `resolved_model` will no longer be a real
  upstream model.

### (4) /responses prompt caching — `cache_read_input_tokens`, TTFT, latency

- **Signal:** `cache_read_input_tokens` on a **second** identical large-context
  `/v1/messages` request that routes to a GPT `/responses` model, plus TTFT and
  total latency for each request.
- **Code today:** the upstream cache key (`prompt_cache_key`) is sent, so a fast
  repeat already reuses context. But `prompt_cache_retention: "24h"` is
  **commented out** at `src/routes/messages/responses-translation.ts:87`
  (`//prompt_cache_retention: "24h",  not work in gpt-5.4`), so there is **no
  24h retention** — reuse decays once the upstream in-memory window closes.
  `cache_read_input_tokens` is emitted from the responses translation at
  `responses-translation.ts:714` (non-stream) and
  `responses-stream-translation.ts:534` (`message_start`; the final figure lands
  in `message_delta`).
- **Baseline result (3 s gap):** first request `cache_read 0`; second request
  `cache_read ~28k` → **cache reused: true**. This proves the *fast-repeat*
  reuse only.
- **After workstream (4):** with retention enabled, re-run with a
  `--cache-gap-ms` larger than the upstream in-memory window (i.e. long enough
  that the baseline build would drop to `cache_read 0` on the second request).
  Sustained non-zero `cache_read` across that longer gap is the 24h-retention
  win.

## Notes

- Pure logic (SSE/JSON parsing, verdicts, report shaping) is exported and
  covered by `tests/measure-baseline.test.ts` — no network, honors ADR-0011
  mock discipline (the tests touch no live modules).
- The caching probe requires the measurement model to route via `/responses`
  (a GPT model). Claude models 400 on `/responses`, so don't point `--model` at
  a Claude id for metric (4).
