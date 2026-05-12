import { defineConfig } from "vite";
import { resolve } from "path";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
//
// Multi-page input: each Tauri window points to its own HTML entry.
// - index.html : placeholder/legacy entry (no window opens it directly)
// - setup.html : Setup window (see docs/first-run-setup-prd.md)
//
// Tauri picks the page via the URL passed to WebviewWindowBuilder in
// `src-tauri/src/lib.rs`. In dev, both are served from
// http://localhost:1420/<name>.html.
export default defineConfig(async () => ({
  clearScreen: false,
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        setup: resolve(__dirname, "setup.html"),
      },
    },
  },
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
}));
