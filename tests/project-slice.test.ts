import { describe, expect, test } from "bun:test"

import {
  DEFAULT_PROJECT_SLICE_CAP,
  curateProjectSlice,
  type Project,
} from "../shell/src/ui/nav/project-slice"

/**
 * Bounded rail slice (spec §2.2–§2.3, §10 invariant "curateProjectSlice caps the
 * rail at N=0/3/6/7/50"). Pure function — the rail height must stay constant as the
 * project set grows unbounded. Skipped until the body lands.
 */

function project(slug: string, pinned = false, lastActiveAt = 0): Project {
  return { slug, label: slug, pinned, lastActiveAt }
}

function many(n: number): Array<Project> {
  return Array.from({ length: n }, (_, i) => project(`p${i}`, false, i))
}

describe("curateProjectSlice — unskip when implemented", () => {
  test("N=0 → empty slice, no overflow", () => {
    expect(curateProjectSlice([])).toEqual({ items: [], hasOverflow: false })
  })

  test("N=3 (< cap) → shows all three, no overflow", () => {
    const slice = curateProjectSlice(many(3))
    expect(slice.items).toHaveLength(3)
    expect(slice.hasOverflow).toBe(false)
  })

  test("N=6 (== cap) → shows all six, no overflow", () => {
    const slice = curateProjectSlice(many(6))
    expect(slice.items).toHaveLength(DEFAULT_PROJECT_SLICE_CAP)
    expect(slice.hasOverflow).toBe(false)
  })

  test("N=7 (> cap) → truncates to cap, overflow true", () => {
    const slice = curateProjectSlice(many(7))
    expect(slice.items).toHaveLength(DEFAULT_PROJECT_SLICE_CAP)
    expect(slice.hasOverflow).toBe(true)
  })

  test("N=50 → rail height stays constant at the cap", () => {
    const slice = curateProjectSlice(many(50))
    expect(slice.items).toHaveLength(DEFAULT_PROJECT_SLICE_CAP)
    expect(slice.hasOverflow).toBe(true)
  })

  test("pinned projects come first, then most-recent fill the remainder", () => {
    const projects = [
      project("recent-old", false, 1),
      project("pinned-a", true, 0),
      project("recent-new", false, 100),
      project("pinned-b", true, 0),
    ]
    const slice = curateProjectSlice(projects, 3)
    expect(
      slice.items
        .slice(0, 2)
        .map((p) => p.slug)
        .sort(),
    ).toEqual(["pinned-a", "pinned-b"])
    expect(slice.items[2]?.slug).toBe("recent-new") // newest non-pinned fills
    expect(slice.hasOverflow).toBe(true)
  })
})
