import { glob } from "astro/loaders";
import { defineCollection } from "astro:content";

// The landing page body is authored in Markdoc (.mdoc). One entry today
// (index), but a collection keeps the door open for additional content pages.
const landing = defineCollection({
  loader: glob({ pattern: "**/*.mdoc", base: "./src/content/landing" }),
});

export const collections = { landing };
