import { component, defineMarkdocConfig } from "@astrojs/markdoc/config";

// Maps Markdoc tags used in src/content/landing/*.mdoc to brand Astro
// components. Dynamic data (the resolved release/version + download URLs) flows
// in as Markdoc variables from index.astro and is referenced in the .mdoc as
// `$version`, `$macDmg`, etc., then handed to the tag as an attribute value.
export default defineMarkdocConfig({
  tags: {
    hero: {
      render: component("./src/components/markdoc/Hero.astro"),
      attributes: {
        tagline: { type: String, required: true },
        downloadLabel: { type: String },
      },
    },
    showtell: {
      render: component("./src/components/markdoc/ShowTell.astro"),
    },
    getstarted: {
      render: component("./src/components/markdoc/GetStarted.astro"),
    },
  },
});
