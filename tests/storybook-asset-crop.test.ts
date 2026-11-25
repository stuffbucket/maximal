import { describe, expect, test } from "bun:test"

import {
  cropBounds,
  type CropTarget,
} from "../packages/storybook/scripts/asset-crop"

const page = { pageHeight: 600, pageWidth: 800 }
const target = (box: Partial<CropTarget>): CropTarget => ({
  ...page,
  bottom: 300,
  left: 100,
  right: 300,
  top: 100,
  ...box,
})

describe("Storybook asset crop bounds", () => {
  test("pads all sides when the target is inside the page", () => {
    expect(cropBounds(target({}), 8)).toEqual({
      x: 92,
      y: 92,
      width: 216,
      height: 216,
    })
  })

  test("clamps padding at the origin and shrinks the size to match", () => {
    expect(cropBounds(target({ left: 3, top: 5 }), 8)).toEqual({
      x: 0,
      y: 0,
      width: 308,
      height: 308,
    })
  })

  test("clamps padding at the far page edges", () => {
    expect(cropBounds(target({ right: 797, bottom: 595 }), 8)).toEqual({
      x: 92,
      y: 92,
      width: 708,
      height: 508,
    })
  })

  test("never cuts a target that overflows the page (fixed dialog taller than the document)", () => {
    expect(cropBounds(target({ top: 0, bottom: 900 }), 8)).toEqual({
      x: 92,
      y: 0,
      width: 216,
      height: 900,
    })
  })

  test("snaps fractional boxes outward to whole pixels", () => {
    expect(
      cropBounds(
        target({ left: 10.4, right: 20.2, top: 10.4, bottom: 20.2 }),
        0,
      ),
    ).toEqual({
      x: 10,
      y: 10,
      width: 11,
      height: 11,
    })
  })
})
