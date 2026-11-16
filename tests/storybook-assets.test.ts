import { describe, expect, test } from "bun:test"

import {
  assetFileStem,
  parseAssetArgs,
  selectStoryEntries,
  type StorybookEntry,
} from "../packages/storybook/scripts/asset-policy"
import { ignoreStorybookRestagePath } from "../packages/storybook/scripts/watch-policy"

const entries: Array<StorybookEntry> = [
  {
    id: "assets-glyphs--allow",
    name: "Allow",
    tags: ["asset"],
    title: "Assets/Glyphs",
    type: "story",
  },
  {
    id: "components-button--primary",
    name: "Primary",
    tags: [],
    title: "Components/Button",
    type: "story",
  },
  {
    id: "components-button--docs",
    name: "Docs",
    tags: ["asset"],
    title: "Components/Button",
    type: "docs",
  },
]

describe("Storybook development watch policy", () => {
  test("does not restage for static sources copied by the UI build", () => {
    expect(
      ignoreStorybookRestagePath("settings/vendor/fonts/Inter.woff2"),
    ).toBe(true)
    expect(
      ignoreStorybookRestagePath("ui/features/apps/icons/chatgpt.svg"),
    ).toBe(true)
    expect(ignoreStorybookRestagePath("ui/features/apps/HarnessIcon.tsx")).toBe(
      false,
    )
  })
})

describe("Storybook asset export policy", () => {
  test("defaults to deterministic asset-tagged stories", () => {
    const options = parseAssetArgs([])
    expect(options.tags).toEqual(["asset"])
    expect(options.themes).toEqual(["light", "dark"])
    expect(
      selectStoryEntries(entries, options).map((entry) => entry.id),
    ).toEqual(["assets-glyphs--allow"])
  })

  test("combines ids, globs and tags while excluding docs", () => {
    const options = parseAssetArgs([
      "components-button--primary",
      "--match",
      "assets-*",
      "--tag",
      "other",
    ])
    expect(
      selectStoryEntries(entries, options).map((entry) => entry.id),
    ).toEqual(["assets-glyphs--allow", "components-button--primary"])
  })

  test("rejects unknown exact ids instead of silently exporting nothing", () => {
    const options = parseAssetArgs(["missing--story"])
    expect(() => selectStoryEntries(entries, options)).toThrow(
      "Unknown story missing--story",
    )
  })

  test("parses rendering controls and makes variant-safe filenames", () => {
    const options = parseAssetArgs([
      "--all",
      "--format",
      "png",
      "--theme",
      "dark",
      "--theme",
      "dark",
      "--locale",
      "de",
      "--viewport",
      "800x600",
      "--scale",
      "3",
      "--padding",
      "0",
    ])
    expect(options).toMatchObject({
      all: true,
      format: "png",
      locale: "de",
      padding: 0,
      scale: 3,
      themes: ["dark"],
      viewport: { height: 600, width: 800 },
    })
    expect(assetFileStem(entries[0], options.themes[0], options.locale)).toBe(
      "assets-glyphs--allow--dark--de",
    )
  })
})
