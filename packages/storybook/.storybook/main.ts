import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { StorybookConfig } from "@storybook/react-vite";
import react from "@vitejs/plugin-react";
import { mergeConfig } from "vite";

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = resolve(PKG, "../..");

const config: StorybookConfig = {
  framework: "@storybook/react-vite",
  stories: ["../src/**/*.stories.@(ts|tsx)"],
  addons: ["@storybook/addon-docs", "@storybook/addon-a11y"],
  staticDirs: [
    // Self-hosted fonts, same files the Settings window serves.
    { from: "../../../shell/ui/settings/vendor", to: "/vendor" },
    // The real built Settings + Dashboard UI with the mock bootstrap
    // injected — written by scripts/prepare-ui.ts.
    { from: "../.ui", to: "/ui" },
  ],
  // Same no-telemetry posture as the app.
  core: { disableTelemetry: true },
  async viteFinal(base) {
    return mergeConfig(base, {
      plugins: [react()],
      resolve: {
        // Stories import components straight from shell/src, whose bare
        // `react` imports would otherwise resolve to shell/node_modules — a
        // second React. Force everything onto this package's copy.
        dedupe: ["react", "react-dom"],
        // Nothing in Storybook runs inside Tauri; stub invoke() so it fails
        // the way it does in a plain browser, without needing shell deps.
        alias: [
          {
            find: /^@tauri-apps\/api\/core$/,
            replacement: join(PKG, "src/mock/tauri-core.ts"),
          },
        ],
      },
      server: {
        // shell/src, scripts/ and src/lib live outside this package.
        fs: { allow: [REPO] },
        // .ui/ is static output restaged on every shell save (scripts/dev.ts);
        // window stories reload it themselves, so don't full-reload the preview.
        // A predicate rather than a glob: Vite's watcher doesn't glob-match
        // dot-directories reliably.
        watch: {
          ignored: (file: string) => /[\\/](\.ui|storybook-static)([\\/]|$)/.test(file),
        },
      },
    });
  },
};

export default config;
