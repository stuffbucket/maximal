// @ts-check
import { defineConfig } from "astro/config";

// GitHub Pages project site: served at https://stuffbucket.github.io/maximal/
export default defineConfig({
  site: "https://stuffbucket.github.io/maximal",
  base: "/maximal",
  output: "static",
  trailingSlash: "ignore",
});
