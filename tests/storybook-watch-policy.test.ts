import { describe, expect, test } from "bun:test"

import { ignoreStorybookWatchPath } from "../packages/storybook/scripts/watch-policy"

describe("Storybook watch policy", () => {
  test("watches staged window UI but ignores the static build output", () => {
    expect(
      ignoreStorybookWatchPath(
        "/repo/packages/storybook/.ui/settings/index.html",
      ),
    ).toBe(false)
    expect(
      ignoreStorybookWatchPath(
        String.raw`C:\repo\packages\storybook\.ui\dashboard\index.html`,
      ),
    ).toBe(false)
    expect(
      ignoreStorybookWatchPath(
        "/repo/packages/storybook/storybook-static/index.html",
      ),
    ).toBe(true)
    expect(
      ignoreStorybookWatchPath(
        String.raw`C:\repo\packages\storybook\storybook-static\index.html`,
      ),
    ).toBe(true)
    expect(
      ignoreStorybookWatchPath(
        "/repo/packages/storybook/storybook-static-copy/index.html",
      ),
    ).toBe(false)
  })
})
