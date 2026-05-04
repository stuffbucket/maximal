import { defineConfig } from "tsdown"

export default defineConfig({
  entry: ["src/main.ts"],

  format: ["esm"],
  target: "es2022",
  platform: "node",

  sourcemap: true,
  clean: true,
  removeNodeProtocol: false,

  // Copy proxy-served HTML (the usage-viewer dashboard) alongside
  // the bundled JS so `readFileSync(new URL("./pages/...",
  // import.meta.url))` resolves at runtime. The public-facing GH
  // Pages site lives at `pages/` (repo root) and is not bundled.
  copy: [{ from: "src/pages", to: "dist/pages" }],

  env: {
    NODE_ENV: "production",
  },
})
