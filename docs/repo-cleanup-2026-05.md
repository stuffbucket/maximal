# Repo cleanup — 2026-05

One PR. Disjoint work units so subagents in parallel worktrees don't
collide. Each unit is independently revertible.

## Approved scope (this PR)

### Unit A — macOS PATH fix

**Problem.** `build/macos/app-template/Contents/MacOS/first-launch`
installs the sidecar to `~/.local/bin/maximal` but nothing adds
`~/.local/bin` to the user's interactive shell `PATH`. macOS users get
"command not found" from a fresh terminal unless they've already
configured this themselves. Windows handles it (`install.ps1` /
`maximal.wxs`); macOS does not.

**Fix.** Extend `first-launch` to idempotently append
`export PATH="$HOME/.local/bin:$PATH"` (guarded by a marker comment) to
`~/.zshrc` and `~/.zprofile` when missing. zsh is the macOS default
since Catalina; we only touch zsh files. Re-runs must not duplicate.

Idempotency contract:

```bash
MARKER='# >>> maximal PATH >>>'
for rc in "$HOME/.zshrc" "$HOME/.zprofile"; do
  [ -f "$rc" ] || touch "$rc"
  grep -qF "$MARKER" "$rc" || cat >> "$rc" <<EOF

$MARKER
export PATH="\$HOME/.local/bin:\$PATH"
# <<< maximal PATH <<<
EOF
done
```

Place the block after the existing binary-copy step, before the user
notification. Don't `source` the rc inside the script — the dock-clicked
launcher has no interactive shell to update; new terminals pick it up.

### Unit B — Root cleanup

Delete the following (user-approved):

- `AGENTS.md` — stale, references the wrong build tool, predates `AGENT.md`.
- `Dockerfile`, `Dockerfile.claude`, `docker-compose.yml`, `entrypoint.sh`, `.dockerignore` — upstream `caozhiyuan/copilot-api` relics; no current workflow uses Docker.
- `start.bat` — superseded by `build/windows/install.ps1`.
- `pages/index.html` and the empty `pages/` directory — orphaned, zero references.

`.DS_Store` sweep:

- `git rm` the tracked `src/routes/.DS_Store`.
- Remove all untracked `.DS_Store` files from the working tree (`find . -name .DS_Store -not -path "./node_modules/*" -not -path "./.git/*" -delete`).
- Confirm `.DS_Store` is in `.gitignore` (it is, line 12 — good).

If any GitHub Actions workflow or doc references the deleted files,
update or delete those references. Likely candidates: `.github/workflows/*.yml`, README.md, AGENT.md, CLAUDE.md.

### Unit C — Extract `web-tools/` subpackage

`src/routes/messages/` has 10 sibling `web-tools-*.ts` files. Group them.

**Move:**
```
src/routes/messages/web-tools-agent.ts     → src/routes/messages/web-tools/agent.ts
src/routes/messages/web-tools-exec.ts      → src/routes/messages/web-tools/exec.ts
src/routes/messages/web-tools-executor.ts  → src/routes/messages/web-tools/executor.ts
src/routes/messages/web-tools-flow.ts      → src/routes/messages/web-tools/flow.ts
src/routes/messages/web-tools-rewriter.ts  → src/routes/messages/web-tools/rewriter.ts
src/routes/messages/web-tools-state.ts     → src/routes/messages/web-tools/state.ts
src/routes/messages/web-tools-stream.ts    → src/routes/messages/web-tools/stream.ts
src/routes/messages/web-tools-types.ts     → src/routes/messages/web-tools/types.ts
src/routes/messages/web-tools-vocab.ts     → src/routes/messages/web-tools/vocab.ts
```

Create `src/routes/messages/web-tools/index.ts` that re-exports the public surface (whatever `handler.ts` and tests currently import).

**Update imports** in:
- `src/routes/messages/handler.ts` and any other in-tree consumers.
- `tests/*.test.ts` that import these modules directly.
- Update `tsconfig.json` paths if needed (likely not — `~/` alias still resolves).

**Validate:** `bun run check:fast` must pass; `bun test` for messages-related tests must pass.

### Unit D — Docs archive sweep

`docs/spec/` has 15 specs (~4,300 lines) including 7 phase docs. Most are
historical planning. Archive shipped/superseded ones; keep only active
planning at the top level.

**Action:**

1. For each file in `docs/spec/`, decide: **active** (current planning) vs **archive** (shipped or superseded).
2. `mkdir -p docs/spec/archive/`.
3. `git mv` archived specs into `docs/spec/archive/`.
4. Add a one-line `**Status:** archived 2026-05` header at the top of each archived file (preserve the rest verbatim).

**Heuristic for archival** (when in doubt, archive):

- `phase-1` … `phase-3` — almost certainly shipped (CI hardening, build simplification, macOS test parity). Archive.
- `phase-4` … `phase-7` — recent; archive only if you can confirm shipped via git log on referenced files.
- `internal-distribution.md` + `-stream-a.md` + `-stream-b.md` — at least one is superseded by the others. Archive the older ones.
- `observability.md`, `model-protocol-strategy.md`, `tool-bridge.md`, `web-tools.md`, `state-config-cache-cleanup.md` — keep if active, archive if implemented.

If you can't decide, leave it active. Don't lose information.

Same treatment optional for top-level `docs/*-prd.md` — out of scope for this PR.

## Skipped (deferred to future PRs)

- **`src/lib/` subfoldering** — high churn; do on a quiet branch.
- **Tests reorg to mirror `src/`** — depends on lib reorg.
- **`src/pages/` → `src/usage-viewer/` rename** — touches many imports, build scripts, and the served HTML's asset paths.
- **Build-output dir consolidation** (`dist-build/` → `out/sidecar/` etc.) — release pipelines depend on these names; needs a coordinated CI bump.
- **`bun run clean` script** — nice to have but not blocking.

## Integration

- Each unit in its own worktree on `cleanup/<unit>` branch off `main`.
- Merge sequentially into `cleanup/may-2026` integration branch.
- Run `bun run check:deep` on the integration branch.
- Open one PR; monitor CI and address failures before merge.
