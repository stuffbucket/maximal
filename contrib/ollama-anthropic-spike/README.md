# Ollama Anthropic-compat spike

Reference implementation we're cribbing from for the web-tools
interceptor. Vendored copy of `ollama/ollama` `middleware/anthropic.go`
(+ tests) at the May 2026 commit, MIT-licensed upstream.

- `anthropic.go` — the `WebSearchAnthropicWriter` middleware
- `anthropic_test.go` — tests (3000 LOC; useful for porting later)
- `NOTES.md` — side-by-side mapping vs our
  `src/routes/messages/web-tools-*.ts` and
  recommendations for the missing D6 (`web-tools-agent.ts`)

This directory is scratch — not built, not linted. Delete after the
agent loop lands.
