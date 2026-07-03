/**
 * The canonical subcommand a client's config points at: `maximal api <client>`.
 *
 * Lives in its own dependency-free leaf module (no `config`/`paths` imports) so
 * `src/main.ts` can key its subcommand map on it WITHOUT dragging the config
 * chain into module-load — main.ts must set `COPILOT_API_*` env vars from argv
 * *before* anything reads `PATHS`. `~/lib/api-key-helper` re-exports this so the
 * on-disk command builder and the CLI command name share one source of truth
 * and cannot drift.
 */
export const HELPER_SUBCOMMAND = "api"

/** The legacy flag maximal still accepts for the helper. A command carrying
 *  this form is recognized as ours and healed forward to the current `api
 *  <client>` form on the next apply/boot. */
export const LEGACY_HELPER_FLAG = "--apiKeyHelper"
