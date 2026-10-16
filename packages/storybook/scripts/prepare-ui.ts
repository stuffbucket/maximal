#!/usr/bin/env bun
/**
 * Stages the REAL built Settings + Dashboard UI for the window stories.
 *
 *   1. Runs the repo's own UI build (scripts/build-ui.ts → shell/dist/ui).
 *   2. Copies shell/dist/ui to .ui/ (served by Storybook at /ui/*).
 *   3. Bundles src/mock/window-bootstrap.ts to .ui/__storybook-mock.js and
 *      injects it as the first script of each page, so the page talks to
 *      the shared mock sidecar (scripts/ui-harness-api.ts) instead of :4141.
 *
 * No UI source is modified; the pages in .ui/ are byte-for-byte the shipped
 * ones plus one <script> tag.
 *
 * Usage (from packages/storybook):
 *   bun scripts/prepare-ui.ts        # one-shot (run by `pnpm build`)
 */
import { cp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const PKG = resolve(import.meta.dir, "..");
export const REPO = resolve(PKG, "../..");
const DIST = join(REPO, "shell/dist/ui");
const OUT = join(PKG, ".ui");
const BOOTSTRAP_ENTRY = join(PKG, "src/mock/window-bootstrap.ts");
const BOOTSTRAP_NAME = "__storybook-mock.js";
const PAGES = ["settings", "dashboard"] as const;

export async function buildUi(): Promise<void> {
  const proc = Bun.spawn([process.execPath, "scripts/build-ui.ts"], {
    cwd: REPO,
    stdout: "inherit",
    stderr: "inherit",
  });
  if ((await proc.exited) !== 0) throw new Error("scripts/build-ui.ts failed");
}

export async function stageUi(): Promise<void> {
  await rm(OUT, { recursive: true, force: true });
  await cp(DIST, OUT, { recursive: true });

  const result = await Bun.build({
    entrypoints: [BOOTSTRAP_ENTRY],
    outdir: OUT,
    target: "browser",
    // A classic script runs before the pages' module scripts.
    format: "iife",
    naming: BOOTSTRAP_NAME,
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error("mock bootstrap build failed");
  }

  for (const page of PAGES) {
    const file = join(OUT, page, "index.html");
    const html = await readFile(file, "utf8");
    const tag = `<script src="../${BOOTSTRAP_NAME}"></script>`;
    const charset = /<meta\s+charset[^>]*>/i;
    if (!charset.test(html)) {
      throw new Error(`${page}/index.html has no <meta charset> to inject after`);
    }
    await writeFile(file, html.replace(charset, (m) => `${m}\n    ${tag}`));
  }
}

if (import.meta.main) {
  const t = Date.now();
  await buildUi();
  await stageUi();
  console.error(`[storybook] staged mock-backed UI → .ui (${Date.now() - t}ms)`);
}
