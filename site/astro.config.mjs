// @ts-check
import markdoc from "@astrojs/markdoc";
import { defineConfig } from "astro/config";

// GitHub Pages project site: served at https://stuffbucket.github.io/maximal/
// The landing copy + page structure live in a Markdoc content collection
// (src/content/landing/index.mdoc) rendered through custom tag-components.
// index.astro stays a thin shell that resolves the release (lib/version.ts)
// and passes it in as Markdoc variables, so the version logic is untouched.
export default defineConfig({
  site: "https://stuffbucket.github.io/maximal",
  base: "/maximal",
  output: "static",
  trailingSlash: "ignore",
  integrations: [markdoc()],
});
