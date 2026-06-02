import react from "@vitejs/plugin-react";
import { codeInspectorPlugin } from "code-inspector-plugin";
import type { Plugin } from "vite";
import { defineConfig } from "vite";
import Inspect from "vite-plugin-inspect";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

/**
 * Stamps `data-insp-path` attributes on every element in `index.html`
 * so the code-inspector-plugin runtime can resolve hover → source file.
 *
 * The shell UI is vanilla HTML in `index.html` with vanilla TS in
 * `src/main.ts` only wiring event handlers. code-inspector-plugin's
 * own transformer only handles JSX/Vue/Svelte templates, so plain
 * static markup never gets attributed — its runtime walks the DOM
 * looking for `data-insp-path`, finds nothing, and the Shift+Opt
 * overlay never appears. This plugin fills that gap with a streaming
 * scan that tracks line/column and inserts `data-insp-path="path:l:c"`
 * after each opening tag name. Skips structural shells (`<html>`,
 * `<head>`, `<body>`), head-only tags, comments, and the doctype.
 */
function htmlSourcemap(): Plugin {
  // Tags whose hover would surface nothing useful — skip to keep the
  // overlay focused on user-visible content.
  const skip = new Set([
    "!doctype",
    "html",
    "head",
    "body",
    "script",
    "style",
    "link",
    "meta",
    "title",
    "base",
  ]);

  return {
    name: "html-data-insp-path",
    apply: "serve",
    transformIndexHtml: {
      order: "pre",
      handler(html, ctx) {
        const file = ctx.filename;
        const out: string[] = [];
        let line = 1;
        let col = 1;
        let i = 0;
        const n = html.length;

        while (i < n) {
          const ch = html[i];

          // Skip comments wholesale (<!-- ... -->) so we don't try to
          // attribute pseudo-tags inside them.
          if (html.startsWith("<!--", i)) {
            const end = html.indexOf("-->", i + 4);
            const stop = end === -1 ? n : end + 3;
            for (let k = i; k < stop; k++) {
              advancePos(html[k]);
              out.push(html[k]);
            }
            i = stop;
            continue;
          }

          // Opening tag? Match `<tagname` (allow `!` for doctype).
          if (ch === "<" && i + 1 < n && /[a-zA-Z!]/.test(html[i + 1])) {
            const tagStart = i;
            const lineAtTag = line;
            const colAtTag = col;
            let j = i + 1;
            while (j < n && /[a-zA-Z0-9!-]/.test(html[j])) j++;
            const tagName = html.slice(i + 1, j).toLowerCase();

            // Emit `<tagname` verbatim, advancing line/col.
            for (let k = i; k < j; k++) {
              advancePos(html[k]);
              out.push(html[k]);
            }
            i = j;

            if (!skip.has(tagName) && !/^\//.test(tagName)) {
              // Insert the attribute immediately after the tag name,
              // before any other attributes or `>`. The runtime splits
              // the value on `:` and expects four trailing fields —
              // `path:line:column:tagName`. The path itself may contain
              // `:` (Windows drive letters); the runtime joins all
              // segments except the last three back together with `:`.
              const attr = ` data-insp-path="${file}:${lineAtTag}:${colAtTag}:${tagName}"`;
              out.push(attr);
              // Synthetic chars — don't advance line/col.
            }
            continue;
          }

          advancePos(ch);
          out.push(ch);
          i++;
        }

        return out.join("");

        function advancePos(c: string): void {
          if (c === "\n") {
            line++;
            col = 1;
          } else {
            col++;
          }
        }
      },
    },
  };
}

// https://vite.dev/config/
export default defineConfig(async ({ command }) => ({
  // Dev-only plugin stack — all three are gated by `command === "serve"`
  // so production bundles never carry the dependency surface.
  //
  // 1. htmlSourcemap (local, below): stamps `data-insp-path` on every
  //    element in index.html so code-inspector-plugin's runtime can
  //    resolve hover → source. Plain static markup is otherwise opaque
  //    to that plugin (it only transforms JSX/Vue/Svelte templates).
  //
  // 2. code-inspector-plugin: hold Shift+Opt and hover an element to
  //    overlay its source file/line; click to open it in VS Code.
  //
  // 3. vite-plugin-inspect: open /settings/.vite-inspect/ for a
  //    transform-pipeline + "open in editor" UI. Independent of the
  //    hover overlay — useful for debugging Vite plugin order, CSS
  //    transforms, etc.
  plugins:
    command === "serve"
      ? [
          // code-inspector-plugin asks to come before @vitejs/plugin-react
          // so its transform runs first on JSX.
          codeInspectorPlugin({
            bundler: "vite",
            editor: "code",
            hotKeys: ["shiftKey", "altKey"],
            hideConsole: false,
          }),
          react(),
          htmlSourcemap(),
          Inspect(),
          {
            name: "log-inspect-url",
            configureServer(server) {
              const originalPrint = server.printUrls.bind(server);
              server.printUrls = () => {
                originalPrint();
                const port = server.config.server.port;
                const base = server.config.base;
                const url = `http://localhost:${port}${base}.vite-inspect/`;
                server.config.logger.info(`  →  Inspect: ${url}`);
                server.config.logger.info(
                  `  →  Source overlay: hold Shift+Opt and hover an element to jump to its file in VS Code.`,
                );
                server.config.logger.info(
                  `  →  API calls hit the proxy on :4141 — run \`bun run dev\` in another terminal.`,
                );
              };
            },
          },
        ]
      : [react()],

  // The proxy serves this bundle under /settings (see
  // src/routes/settings/route.ts). Base path makes index.html reference
  // its assets at /settings/assets/... rather than /assets/..., which
  // is what the proxy route expects in both dev (reverse-proxied to
  // Vite, which honours `base`) and prod (served from disk).
  base: "/settings/",

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
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
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },

  // Multi-page build: the settings UI (index.html) plus the pre-boot
  // splash (splash.html). The splash is loaded by the Tauri shell via
  // WebviewUrl::App("splash.html") before the sidecar is up, so it must
  // be emitted as its own entry at the dist root. It is self-contained
  // (no asset imports), so the "/settings/" base never rewrites anything
  // inside it.
  build: {
    rollupOptions: {
      input: {
        main: "index.html",
        splash: "splash.html",
      },
    },
  },
}));
