// Bun's `with { type: "file" }` import attribute resolves at runtime to a
// filesystem path string (dev) or `$bunfs/...` path (compiled binary).
// TypeScript's bundler-mode resolution doesn't know about non-TS asset
// extensions, so we declare them here.
//
// See src/server.ts for the usage pattern.

declare module "*.html" {
  const path: string
  export default path
}

declare module "*.css" {
  const path: string
  export default path
}
