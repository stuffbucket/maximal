import { glob } from "astro/loaders";
import { defineCollection } from "astro:content";

// The landing page body is authored in Markdoc (.mdoc). One entry today
// (index), but a collection keeps the door open for additional content pages.
const landing = defineCollection({
  loader: glob({ pattern: "**/*.mdoc", base: "./src/content/landing" }),
});

// The user guide lives as plain Markdown in the repo (docs/guide/*.md) so it's
// browsable on GitHub and stays the single source of truth. It's surfaced on
// the site at /guide via this collection. README.md is the repo index and is
// filtered out of the routed pages.
const guide = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "../docs/guide" }),
});

export const collections = { landing, guide };
