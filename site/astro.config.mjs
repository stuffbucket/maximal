// @ts-check
import markdoc from "@astrojs/markdoc";
import { defineConfig } from "astro/config";

// Served at the branded apex domain https://mxml.sh/ — a GitHub Pages custom
// domain (declared in site/public/CNAME), so the site deploys at the ROOT path,
// NOT the project subpath. `base` MUST therefore be "/": a "/maximal" base emits
// /maximal/* asset URLs (via import.meta.env.BASE_URL) that 404 at the
// root-served domain. GitHub 301-redirects stuffbucket.github.io/maximal/ here.
// The landing copy + page structure live in a Markdoc content collection
// (src/content/landing/index.mdoc) rendered through custom tag-components.
// index.astro stays a thin shell that resolves the release (lib/version.ts)
// and passes it in as Markdoc variables, so the version logic is untouched.
export default defineConfig({
  site: "https://mxml.sh",
  base: "/",
  output: "static",
  trailingSlash: "ignore",
  integrations: [markdoc()],
});
