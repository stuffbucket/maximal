# Windows whole-system validation — plan

Status: **planned, not built.** This doc captures (a) what the Windows build
spike already proves, and (b) a phased plan to grow it from a *build* gate into a
*whole-system* gate that boots the app, runs synthetic transcripts through the
real pipeline, and asserts the components work together. See also
[`testing-strategy.md`](./testing-strategy.md) and
[`live-test-build-checklist.md`](./live-test-build-checklist.md).

## What the spike already proves (2026-07-27)

The two Windows dev workflows were dispatched against a branch and both passed on
`windows-2022`:

- **`windows-shell-dev.yml`** — win-x64 sidecar compile → Tauri **NSIS build** →
  NSIS silent install → Start Menu launcher verified. Proves the app **builds +
  installs**.
- **`windows-installer-dev.yml`** — cross-compiled binary → MSI **and**
  `install.ps1`/scheduled-task paths → **proxy starts and serves** on both →
  clean uninstall. Proves the binary **runs + serves**.

This exercised the #388 Windows path/`.exe`/`%APPDATA%` handling on a real host.

### Finding: how to trigger it here
A branch-scoped `push:` trigger was tried and **did not fire** — this repo only
push-runs `main`/`dev` (`ci.yml` `on.push.branches: [main, dev]`); feature
branches validate via `pull_request` or manual dispatch. **The working method is
`workflow_dispatch` against a branch:**

```
gh workflow run windows-shell-dev.yml     --ref <branch> -f version=0.0.0-dev
gh workflow run windows-installer-dev.yml --ref <branch> -f version=0.0.0-dev
```

## Why grow the spike into a broader flow

**Advantages**
- Tests **integration, not just compilation.** The spike proves the binary
  builds and answers a health check; it says nothing about routing → translation
  → usage aggregation → WS live-feed → UI islands working together — the seam
  churned hardest recently (#383–#392) and thinnest on unit coverage.
- **Windows-specific integration bugs surface automatically** (path/`.exe`,
  `%APPDATA%`, CRLF, process spawn, file locks) instead of on manual dispatch.
- **Synthetic transcripts double as executable specs** ("send this → expect this
  translation + this usage row").

**Disadvantages / costs**
- **Slow + expensive on Windows** (~15–30 min Rust build, 2× runner minutes) →
  gate the heavy lanes (nightly / merge-to-main / label), not every PR.
- **Flake.** Headless browser + async WS + timing is flakier than unit tests; a
  flaky *required* check erodes trust → needs disciplined waits + a quarantine
  lane, and should start non-required.
- **Maintenance + fidelity.** Mock upstream + fixtures must track API/model
  changes; a stub validates *our* pipeline, not real Copilot compatibility
  (contract test, not a substitute).
- **GUI gap.** The Tauri window/tray can't run headless; only the browser-tab UI
  (ADR-0018) is drivable without `tauri-driver`. Defer the window/tray E2E.

## Phasing

| Phase | What | Gate |
|---|---|---|
| **1. Headless system test** | Boot the proxy against a stub upstream; drive synthetic transcripts; assert translation/streaming + usage recorded | every PR, all-OS |
| **2. Served-UI E2E** | Playwright loads `/ui/settings` + dashboard against the running proxy; assert islands mount, WS connects, usage reflects the synthetic traffic | Linux per-PR; Windows nightly/label |
| **3. Tauri shell E2E** *(optional)* | `tauri-driver` (WebView2) drives the real window/tray on Windows | nightly only |

The already-validated Windows build is the "build" stage feeding Phases 1–2.

---

## Phase 1 — detailed plan (the next increment)

**Goal:** a cross-OS test that boots the **actual proxy** (the built binary),
points it at a **mock Copilot upstream**, replays **synthetic transcripts**
through the OpenAI/Anthropic/responses endpoints, and asserts the full pipeline
(auth → routing → translation → usage) — with **no real GitHub Copilot auth**.

Out-of-process (against the compiled binary) is deliberate: that is what makes it
a "the *build* runs as expected as a whole" test rather than a unit test.

### Components to build

1. **Mock Copilot upstream** (`tests/e2e/mock-upstream.ts`) — a `Bun.serve`
   stub implementing the two upstream **hosts** the proxy calls when the
   enterprise override is set (see §2 for why it's two, and their exact shape):
   - `https://api.<domain>/copilot_internal/v2/token` — the Copilot token mint
     (`COPILOT_TOKEN_PATH` in `src/lib/config/api-config.ts`). Accepts any GitHub
     token and returns a canned Copilot token.
   - `https://copilot-api.<domain>/…` — chat/completions + messages + responses;
     return canned, fixture-driven upstream responses (streaming + non-streaming).
     Record each received request so the test can assert what the proxy *sent*
     upstream (i.e. that translation happened).

2. **Upstream redirection seam (verified).** Setting `COPILOT_API_ENTERPRISE_URL`
   pins BOTH upstream hosts, and it does so at the **highest precedence** —
   `copilotBaseUrl()` (`api-config.ts`, the `enterpriseDomain` branch) ranks the
   enterprise override *above* token discovery, so we do NOT rely on the minted
   token's `endpoints.api` (an earlier draft of this plan did — that was wrong).
   With `COPILOT_API_ENTERPRISE_URL=<domain>` the proxy calls exactly two hosts:
   - token mint  → `https://api.<domain>` (via `getGitHubApiBaseUrl()`)
   - completions → `https://copilot-api.<domain>` (via `copilotBaseUrl()`)

   **Both are forced `https://`**, so the harness must terminate TLS for both
   subdomains on loopback. Concretely: map `api.<domain>` and `copilot-api.<domain>`
   to `127.0.0.1` (hosts file / a resolver the runner honors) and serve them with a
   **wildcard `*.<domain>` cert** trusted via `NODE_EXTRA_CA_CERTS` (preferred — no
   production code change; confirm Bun's `fetch` honors it). Fallback if that's
   fragile in CI: a test-only, non-production-gated env allowing an `http://`
   upstream override. Pick a `<domain>` that can't resolve publicly (e.g.
   `maximal.test`). Do NOT run as the opencode OAuth app — that branch pins the
   apex host and alters proxy headers; the enterprise override outranks it, but
   keep the harness on the default app to avoid surprises.

3. **Auth seeding.** Pre-seed a fake credential in a temp `COPILOT_API_HOME` so
   the proxy boots "authenticated" and hits the stub for the Copilot token:
   write the `github_token` file / `accounts.json` per
   `src/lib/auth/github-token-store.ts` (schemaVersion 1) + the multi-account
   registry. The stub's token endpoint accepts any GitHub token.

4. **Synthetic transcripts** (`tests/e2e/fixtures/*.json`) — request/expected
   tuples covering: OpenAI chat/completions (stream + non-stream), Anthropic
   messages (stream + non-stream), responses API. Each = client request body +
   stub's canned upstream response + expected proxy output + expected usage delta.

5. **Harness/driver** (`tests/e2e/proxy-system.test.ts` or a standalone runner):
   1. start the mock upstream;
   2. spawn the proxy (built binary, or `bun run src/main.ts start`) with the
      temp home, seeded creds, `COPILOT_API_ENTERPRISE_URL`→stub, a known
      `x-api-key`, on an ephemeral port;
   3. wait for `/` health;
   4. replay each transcript; assert client-facing status/shape/stream + assert
      the stub received the correctly-translated upstream call;
   5. assert **usage recorded** — via the usage/dashboard API endpoint (loopback-
      exempt) or the on-disk usage DB; this is the "components work together"
      signal (request → routing → translation → usage);
   6. tear down (kill proxy, stop stub, rm temp home).

### CI wiring
A new job that reuses the built binary artifact (like `windows-installer-dev`'s
`verify` jobs) and runs the harness against it. Start **non-required**: Linux
every-PR, Windows nightly/on-label. Reuse `windows-installer-dev.yml`'s existing
"download binary artifact → run" shape.

### Assertions that define "works together"
- request → **correct upstream call** (stub records translated request);
- upstream response → **correct client-facing translation** + streaming framing;
- **usage row recorded** with plausible token counts;
- (Phase 2 extends this to: WS live-feed pushed the event; UI island rendered it).

### Open questions / risks (resolve before building)
1. **Two-subdomain TLS + loopback DNS** (§2) — the main technical gate. The
   enterprise override pins `api.<domain>` AND `copilot-api.<domain>`, both
   `https://`, so the harness needs loopback DNS for both subdomains plus a
   wildcard `*.<domain>` cert trusted via `NODE_EXTRA_CA_CERTS`. Confirm Bun's
   `fetch` honors that CA var on all three OSes; the `http://`-override fallback
   is the escape hatch if it's fragile (esp. on the Windows runner).
2. **Auth-seeding fidelity** — exact on-disk shape the token store/loader expects
   so the proxy treats the seeded creds as valid without a network round-trip.
3. **Usage assertion surface** — DB vs API vs WS; pick the most stable (likely the
   loopback-exempt usage API).
4. **Streaming determinism** — assert on normalized event sequences, not raw
   timing, to avoid flake.
5. **Fixture maintenance** — where transcripts live and how they're regenerated
   as models/API shapes change.

## Phase 2 / 3 (outline only)
- **Phase 2:** add Playwright; load `/ui/settings/` + dashboard against the
  running proxy from Phase 1; assert the islands mount, the WS live-feed connects,
  and the usage island reflects the synthetic traffic. Linux per-PR; Windows
  nightly/label.
- **Phase 3 (optional):** `tauri-driver` + WebView2 to drive the real window/tray
  on Windows. Nightly only; accept flakiness; only if the tray starts regressing.
