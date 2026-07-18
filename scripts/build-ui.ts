#!/usr/bin/env bun
/**
 * Build the web UIs into `shell/dist/ui/<surface>/`.
 *
 *   - settings: a React/TSX app — transpiled + bundled by Bun's bundler
 *     (replaces the old Vite build). Browser-runnable plain files.
 *   - dashboard: hand-authored HTML/CSS with a TS module entry
 *     (shell/src/dashboard/main.ts) that imports the shared i18n runtime +
 *     DOM binder, so it localizes on the same catalog as Settings. Bun
 *     bundles that entry. Its Tailwind/Lucide vendors stay CLASSIC global
 *     <script>s (window.tailwind / window.lucide) — the entry references
 *     `window.lucide` rather than importing them, and we copy vendor/
 *     verbatim next to the bundle so those globals load unbundled.
 *
 * Both end up as plain static files served by the proxy under `/ui/*`
 * (src/routes/ui/route.ts): from disk in dev, embedded in the compiled
 * binary in production (see scripts/gen-ui-embed.ts).
 *
 * Usage:
 *   bun scripts/build-ui.ts            # one-shot build
 *   bun scripts/build-ui.ts --watch    # rebuild on change (dev)
 */
import { watch } from "node:fs";
import { cp, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dir, "..");
const SETTINGS_ENTRY = join(REPO, "shell/ui/settings/index.html");
const SETTINGS_VENDOR = join(REPO, "shell/ui/settings/vendor");
const SHELL_DIR = join(REPO, "shell");
const DIST_ROOT = join(REPO, "shell/dist");
const DIST = join(DIST_ROOT, "ui");
const SETTINGS_OUT = join(DIST, "settings");

async function buildSettings(): Promise<void> {
  await rm(SETTINGS_OUT, { recursive: true, force: true });
  await mkdir(SETTINGS_OUT, { recursive: true });
  const result = await Bun.build({
    entrypoints: [SETTINGS_ENTRY],
    outdir: SETTINGS_OUT,
    minify: true,
    sourcemap: "none",
    // The proxy serves this under /ui/settings/; emit asset URLs relative
    // to the HTML so they resolve there in both dev and prod.
    naming: {
      entry: "[name].[ext]",
      chunk: "[name]-[hash].[ext]",
      asset: "[name]-[hash].[ext]",
    },
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error("settings build failed");
  }
  // Self-hosted web fonts. The @font-face rules in index.html reference
  // ./vendor/fonts/*.woff2 with a bare relative URL, which Bun's HTML
  // bundler leaves untouched (it neither inlines nor rewrites them). Copy
  // the vendored woff2 verbatim next to the bundle so the webview never
  // hits a CDN.
  await cp(SETTINGS_VENDOR, join(SETTINGS_OUT, "vendor"), { recursive: true });
}

// Tauri's `frontendDist` (shell/dist) must hold the pre-boot splash it
// loads via `WebviewUrl::App("splash.html")`, plus an index.html so the
// bundler has a valid frontend root. The actual settings UI is served by the
// sidecar at /ui/settings/, so this index is just a pointer.
async function copyShellChrome(): Promise<void> {
  await mkdir(DIST_ROOT, { recursive: true });
  await cp(join(SHELL_DIR, "splash.html"), join(DIST_ROOT, "splash.html"));
  // The branded update-confirm window (WebviewUrl::App("update-confirm.html"))
  // is copied to dist root so the surface is self-contained (it references
  // ./vendor/fonts/*). See updater.rs → open_confirm_window.
  await cp(
    join(SHELL_DIR, "update-confirm.html"),
    join(DIST_ROOT, "update-confirm.html"),
  );
  await mkdir(join(DIST_ROOT, "vendor/fonts"), { recursive: true });
  for (const face of ["fraunces-latin.woff2", "commissioner-latin.woff2"]) {
    await cp(
      join(SHELL_DIR, "ui/settings/vendor/fonts", face),
      join(DIST_ROOT, "vendor/fonts", face),
    );
  }
  await Bun.write(
    join(DIST_ROOT, "index.html"),
    "<!doctype html><meta charset=utf-8><title>Maximal</title>" +
      "<p>Maximal is running. Open Settings from the menu-bar icon.</p>\n",
  );
}

async function buildAll(): Promise<void> {
  const t = Date.now();
  await Promise.all([buildSettings(), copyShellChrome()]);
  console.error(
    `[build-ui] built settings → shell/dist/ui (${Date.now() - t}ms)`,
  );
}

await buildAll();

if (process.argv.includes("--watch")) {
  console.error("[build-ui] watching shell/ui for changes…");
  let timer: ReturnType<typeof setTimeout> | null = null;
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      void buildAll().catch((err) =>
        console.error("[build-ui] rebuild failed:", err),
      );
    }, 80);
  };
  watch(join(REPO, "shell/ui"), { recursive: true }, schedule);
  watch(join(REPO, "shell/src"), { recursive: true }, schedule);
  // Keep the process alive.
  await new Promise(() => {});
}
