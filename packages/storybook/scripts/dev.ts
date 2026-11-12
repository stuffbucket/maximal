#!/usr/bin/env bun
/**
 * `pnpm dev`: stage the window-story UI, start Storybook, and restage on
 * every save under shell/ or the mock sources. Component and island stories
 * hot-reload through Vite on their own; a restage triggers Vite's full reload
 * so mounted window-story iframes pick up the new staged bundle too.
 *
 * Extra args pass through to `storybook dev` (e.g. `pnpm dev --port 6007`).
 */
import { watch } from "node:fs";
import { join, resolve } from "node:path";

import { firstAvailablePort, portIsAvailable, storybookPortOption } from "./port";
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

const extra = process.argv.slice(2);
const requested = storybookPortOption(extra);
let selectedPort = requested.port;
if (selectedPort !== null && !(await portIsAvailable(selectedPort))) {
  const alternative = await firstAvailablePort(selectedPort + 1, Math.min(65_535, selectedPort + 20));
  if (!requested.explicit && alternative !== null) {
    console.error(`[storybook] Port ${selectedPort} is already in use; starting this checkout on ${alternative} instead.`);
    selectedPort = alternative;
  } else {
    const suggestion = alternative === null ? "" : ` Re-run with --port ${alternative} to use a free port.`;
    console.error(
      `[storybook] Port ${selectedPort} is already in use.${suggestion}\n` +
        `  If the existing server is the Storybook you want, open http://127.0.0.1:${selectedPort}/.`,
    );
    process.exit(1);
  }
}
const port = requested.explicit || selectedPort === null ? [] : ["--port", String(selectedPort)];

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
