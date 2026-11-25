---
name: live-operation-smoke
description: >-
  Use when explicitly asked to exercise live Maximal Decisions, SystemOne,
  image generation, or image edit operations against a selected Maximal URL.
  Live POSTs may consume provider quota or money.
---

# Live operation smoke

Use this skill for a running Maximal instance. It separates read-only readiness
checks from live model calls and never retries a POST whose outcome may be
billable.

## Safety rules

- Discover the current worktree's running `app:dev` sidecar from its live session
  sentinel. `--base-url` or `MAXIMAL_BASE_URL` remains an explicit override.
- Run preflight first. It sends no inference request.
- Before any live POST, show the selected operations and get explicit approval.
- Image generation and edit need separate, explicit spend approval. The fixed
  smoke plan is one low-quality 1024×1024 PNG: about **0.6 credits** for a
  generation and **1.4 credits** for an edit. These are estimates, not caps.
- Never put a key in arguments, source, output, or a URL. If request auth is
  enabled, provide a Maximal client key through `MAXIMAL_API_KEY`.
- Never use a GitHub/Copilot token as the client key.
- Do not retry a live POST after a timeout or transport failure; it may already
  have run and billed. Report it as ambiguous and stop.
- Do not change plugin settings, budgets, API keys, or image-tool approval.
- A direct image endpoint does not use the Claude Code image-tool approval gate;
  the script's confirmation flags are therefore mandatory.

## Read-only preflight

From the repository root:

```bash
bun .claude/skills/live-operation-smoke/scripts/smoke.ts
```

The script reads this worktree's live `session-running` sentinel and verifies the
recorded sidecar process before using its actual loopback port. If `app:dev` was
launched with `COPILOT_API_HOME`, run the smoke with the same environment or use
an explicit `--base-url`. It then verifies Maximal identity via `/status`, checks
the three plugin details, `/v1/models`, and `/settings/api/budget`, and reports
bindings and readiness without sending a model request.

A safe negative route probe is also available. It first fails closed if its
sentinel appears in the model catalog or any relevant binding, then requires the
complete non-retryable `404 model_not_enabled` envelope that resolves before
provider I/O:

```bash
bun .claude/skills/live-operation-smoke/scripts/smoke.ts \
  --negative-probes
```

## Live decisions and SystemOne

After explicit approval for the two live requests:

```bash
bun .claude/skills/live-operation-smoke/scripts/smoke.ts \
  --operations decisions,systemone \
  --confirm-live
```

Each operation gets one small, self-checking question. Decisions and SystemOne
are currently described as free on Copilot, but they still consume live model
quota and provider policy can change.

## Live image generation and edit

After explicit approval for an estimated 2.0 image credits:

```bash
bun .claude/skills/live-operation-smoke/scripts/smoke.ts \
  --operations images.generate,images.edit \
  --confirm-live \
  --allow-image-spend \
  --max-planned-image-credits 2.0 \
  --out-dir /tmp/maximal-live-smoke-$(date +%Y%m%d-%H%M%S)
```

The edit always uses the just-generated image from memory; the script never
reads an arbitrary user file. It validates PNG magic bytes, saves files mode
0600 in a new mode-0700 directory, and writes a redacted `report.json` containing
byte counts and SHA-256 hashes, never base64.

`images.edit` requires `images.generate` in the same run. Image parameters are
fixed to low quality, one image, 1024×1024, PNG so this cannot become an ad-hoc
batch generator.

## Remote targets

`--base-url` and `MAXIMAL_BASE_URL` are explicit overrides; if both are set and
differ, the script refuses the ambiguous target. Loopback is accepted by default.
A non-loopback target additionally requires `--allow-remote`; plain HTTP outside
loopback also requires
`--allow-insecure-http`. Authenticated requests use `redirect: "error"`, so a
client key is never followed to another origin.

## Results

Exit codes:

- `0` — all selected checks passed.
- `1` — response/upstream assertion failed.
- `2` — usage, auth, readiness, or confirmation refusal.
- `3` — a live POST had an ambiguous transport outcome and may have executed.

The harness distinguishes `PASS`, `FAIL`, `REFUSED`, and `AMBIGUOUS` outcomes.
Inspect saved images visually after the wire checks pass; schema and magic-byte
validation do not assess image quality.
