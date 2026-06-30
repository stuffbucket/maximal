#!/usr/bin/env node
/**
 * Barrel for the `start` subcommand surface.
 *
 * The body of `start` lives in src/lib/start/ — split there because a
 * single file holding "CLI definition + 10-phase boot orchestrator +
 * shutdown handlers + bootstrap + port preflight + boot-IO" hit 650+
 * lines of mixed concerns. This barrel preserves the
 * `import { ... } from "~/start"` paths that src/main.ts and tests
 * use, so the split is purely a code organization change.
 *
 * Topic files:
 *   src/lib/start/cli.ts                — citty defineCommand
 *   src/lib/start/run-server.ts         — runServer() orchestrator
 *   src/lib/start/port.ts               — probe + evict + reportPortBusyAndExit
 *   src/lib/start/boot-status.ts        — Tauri-relayed status marker
 *   src/lib/start/boot-io.ts            — boot logger + ready banner
 *   src/lib/start/bootstrap.ts          — upstream + secrets bootstrap
 *   src/lib/start/shutdown.ts           — SIGTERM + parent-death handlers
 *   src/lib/start/claude-code-flow.ts   — interactive --claude-code helper
 *   src/lib/start/session-sentinel.ts   — crash-detection session sentinel
 */

export { BOOT_STATUS_MARKER, emitBootStatus } from "~/lib/start/boot-status"
export { start } from "~/lib/start/cli"
export { runServer, type RunServerOptions } from "~/lib/start/run-server"
