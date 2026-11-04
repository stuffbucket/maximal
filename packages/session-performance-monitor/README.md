# Maximal session performance monitor

A deterministic, read-only monitor for Claude Code session metrics exposed by Maximal. It records samples that can be replayed and applies explicit policy thresholds without an LLM.

## Safety and scope

The collector sends only `GET /status` and `GET /token-usage/sessions`. It never changes Maximal state, compacts a conversation, starts a new session, or signals a process. `MAXIMAL_API_KEY` supplies bearer authentication when needed; the key is not accepted as a command-line argument or written to recordings.

Maximal groups a Claude Code parent conversation, its subagents, and related requests under one session ID. Token throughput and cache-read share therefore describe the aggregate group. They are informational and never produce a recommendation. The current endpoints do not include request latency, so this tool does not infer p50 or p95 latency.

## Commands

Run commands from this package directory:

```sh
pnpm install --frozen-lockfile
pnpm monitor -- --samples 8 --interval-ms 60000 --json > recording.json
pnpm analyze -- recording.json
pnpm test
pnpm typecheck
```

The monitor defaults to `http://127.0.0.1:4141` and the latest `claude-code` session. Use `--session <id>` to pin an exact session or `--base-url <url>` for another Maximal instance. Run `bun src/main.ts --help` for all options.

A JSON monitor run writes a complete `MonitorRecording`: schema version, source origin, resolved policy, ordered samples, and the derived report. `analyze` validates the recording and recomputes its report with the recorded policy. Pass `--policy` to evaluate the samples against a different policy file.

## Policy

The default policy requires three samples containing session metrics for a stable no-change verdict; collection gaps do not count. Context growth and ETA are reported only when their samples span at least two minutes.

- Context usage at 75% is `watch`.
- Context usage at 90% recommends compaction.
- Two distinct, explicitly reported compaction timestamps recommend starting a fresh session.
- Two consecutive unhealthy service or Copilot samples recommend investigating service health.

Context growth and a linear context-limit ETA are informational. High throughput, low throughput, and cache share do not trigger recommendations because aggregate session metrics cannot attribute them to the parent conversation or to subagents.

A policy file is a JSON object with any `MonitorPolicy` fields to override. Invalid ratios, counts, or durations are rejected.

## Exit codes

- `0`: no action recommendation, including `watch` and insufficient data.
- `1`: collection, input, or validation error.
- `2`: deterministic action recommendation.
