#!/usr/bin/env bun
/**
 * `pnpm dev`: stage the window-story UI, start Storybook, and restage on
 * every save under shell/ or the mock sources. Component and island stories
 * hot-reload through Vite on their own; the window stories pick up a
 * restage the next time their iframe loads (switch stories or reload).
 *
 * Extra args pass through to `storybook dev` (e.g. `pnpm dev --port 6007`).
 */
import { watch } from "node:fs";
import { join, resolve } from "node:path";

import { REPO, buildUi, stageUi } from "./prepare-ui";

const PKG = resolve(import.meta.dir, "..");
const WATCHED = [
  join(REPO, "shell/ui"),
  join(REPO, "shell/src"),
  join(REPO, "scripts/ui-harness-api.ts"),
  join(REPO, "scripts/ui-harness-fixtures.ts"),
  join(PKG, "src/mock"),
];

async function rebuild(): Promise<void> {
  const t = Date.now();
  await buildUi();
  await stageUi();
  console.error(`[storybook] restaged window UI (${Date.now() - t}ms)`);
}

await rebuild();

// One rebuild at a time; saves that land mid-build queue exactly one more.
let running: Promise<void> | null = null;
let queued = false;
let timer: ReturnType<typeof setTimeout> | null = null;
function schedule(): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    if (running) {
      queued = true;
      return;
    }
    running = rebuild()
      .catch((err) => console.error("[storybook] restage failed:", err))
      .finally(() => {
        running = null;
        if (queued) {
          queued = false;
          schedule();
        }
      });
  }, 150);
}
for (const path of WATCHED) {
  watch(path, { recursive: true }, (_event, file) => {
    // build-ui copies shell/ui/*/vendor/ into dist, and that copy raises
    // change events on the sources here — restaging on them would loop.
    // Vendor bundles only change on deliberate upgrades; restart for those.
    if (file && /(^|[\\/])vendor([\\/]|$)/.test(String(file))) return;
    schedule();
  });
}

const extra = process.argv.slice(2);
const port = extra.includes("--port") || extra.includes("-p") ? [] : ["--port", "6006"];
const storybook = Bun.spawn(["storybook", "dev", ...port, ...extra], {
  cwd: PKG,
  stdio: ["inherit", "inherit", "inherit"],
});
// Ctrl-C reaches the child through the process group, but a plain `kill` of
// this process wouldn't — forward it so Storybook never outlives us.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => storybook.kill(signal));
}
process.exit(await storybook.exited);
