/// <reference types="astro/client" />

// The site has no @types/node dependency, but a few build-time (SSG) endpoints
// read server-only env vars (e.g. GITHUB_TOKEN) via `process.env`. Vite does NOT
// inline non-PUBLIC env vars into `import.meta.env`, so these must be read from
// `process.env`, which only exists in the Node build context and never reaches
// the client bundle. Declare the narrow surface we use so `tsc` is clean without
// pulling in all of @types/node.
declare const process: {
  env: Record<string, string | undefined>;
};
