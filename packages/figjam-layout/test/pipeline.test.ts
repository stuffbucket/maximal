// The recommended pipeline on a real board: the capability map "What the FigJam agent can do"
// (page 8:248), read live with board_tree. Every hard check must pass, and the headline numbers
// are pinned so a routing change shows up here as a deliberate update.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import type { Layout } from "../src/model"

import { classify } from "../src/classify"
import { HARD_CHECKS } from "../src/lanes"
import { planMap } from "../src/pipeline"

const fixture = (name: string): Layout =>
  JSON.parse(
    readFileSync(join(import.meta.dir, "..", "fixtures", name), "utf8"),
  ) as Layout

describe("planMap on the capability map", () => {
  // About 10s: global routing, name tags, four detailed-router settings and the fixpoint.
  test("passes every hard check and keeps its current quality", async () => {
    const R = await planMap(fixture("map-8-248.live.json"))
    const checks = R.checks ?? {}
    const failed = HARD_CHECKS.filter((k) => (checks[k] ?? 0) > 0)
    expect(failed).toEqual([])
    expect(checks.unrouted).toBe(0)
    expect(checks.simplificationsLeft).toBe(0)
    expect(R.routes.length + checks.nameTags).toBe(101)
    expect({
      crossings: checks.crossings,
      wireLength: checks.wireLength,
      nameTags: checks.nameTags,
      tagPills: checks.tagPills,
      bendsMax: checks.bendsMax,
    }).toEqual({
      crossings: 6,
      wireLength: 46480,
      nameTags: 49,
      tagPills: 85,
      bendsMax: 4,
    })
  }, 60_000)
})

describe("classify on the capability map", () => {
  test("groups each family's cards and never permutes the Create rows", () => {
    const groups = classify(fixture("map-8-248.live.json"))
    const bySection = new Map<string, Array<string>>()
    for (const g of groups)
      bySection.set(g.section, [...(bySection.get(g.section) ?? []), g.kind])
    expect(
      Object.fromEntries([...bySection].map(([s, k]) => [s, k.toSorted()])),
    ).toEqual({
      Check: ["ORDERED", "UNORDERED", "UNORDERED", "UNORDERED"],
      Create: ["UNSURE", "UNSURE", "UNSURE"],
      Edit: ["ORDERED", "UNORDERED", "UNSURE", "UNSURE"],
      "Guard & coordinate": [
        "ORDERED",
        "ORDERED",
        "ORDERED",
        "UNORDERED",
        "UNSURE",
      ],
      "Organize & navigate": [
        "ORDERED",
        "ORDERED",
        "UNORDERED",
        "UNSURE",
        "UNSURE",
      ],
      "Read & understand": [
        "ORDERED",
        "ORDERED",
        "UNORDERED",
        "UNORDERED",
        "UNORDERED",
      ],
    })
    for (const g of groups) expect(g.evidence.length).toBeGreaterThan(0)
  })
})
