import { describe, expect, test } from "bun:test"

import {
  autoSides,
  last,
  type Layout,
  must,
  nativeElbow,
  type Rect,
  score,
  simplify,
} from "../src/model"

const box = (x: number, y: number, [w, h] = [100, 60]): Rect => ({
  x,
  y,
  w,
  h,
})

describe("last / must", () => {
  test("last returns the final element and throws on an empty array", () => {
    expect(last([1, 2, 3])).toBe(3)
    expect(() => last([])).toThrow("empty")
  })

  test("must passes a value through and names what was missing", () => {
    expect(must(0, "zero")).toBe(0)
    expect(() => must(new Map<string, number>().get("a"), "node a")).toThrow(
      "missing node a",
    )
  })
})

describe("simplify", () => {
  test("rounds, drops repeated points and collinear middles", () => {
    expect(
      simplify([
        [0, 0],
        [0.2, 0.1],
        [10, 0],
        [20, 0],
        [20, 10.4],
      ]),
    ).toEqual([
      [0, 0],
      [20, 0],
      [20, 10],
    ])
  })
})

describe("autoSides", () => {
  test("cards side by side face each other horizontally", () => {
    expect(autoSides(box(0, 0), box(300, 0))).toEqual(["RIGHT", "LEFT"])
    expect(autoSides(box(300, 0), box(0, 0))).toEqual(["LEFT", "RIGHT"])
  })

  test("stacked cards face each other vertically", () => {
    expect(autoSides(box(0, 0), box(0, 300))).toEqual(["BOTTOM", "TOP"])
    expect(autoSides(box(0, 300), box(0, 0))).toEqual(["TOP", "BOTTOM"])
  })
})

describe("nativeElbow", () => {
  test("leaves and enters each side perpendicular, with orthogonal segments only", () => {
    const pts = nativeElbow(box(0, 0), "RIGHT", box(300, 200), "LEFT")
    expect(pts[0]).toEqual([100, 30])
    expect(pts.at(-1)).toEqual([300, 230])
    for (let i = 1; i < pts.length; i++) {
      const [a, b] = [pts[i - 1], pts[i]]
      expect(a[0] === b[0] || a[1] === b[1]).toBe(true)
    }
  })
})

const layout = (): Layout => ({
  name: "t",
  sections: [],
  nodes: [
    { id: "a", rect: box(0, 0), type: "SHAPE_WITH_TEXT", obstacle: true },
    { id: "b", rect: box(400, 0), type: "SHAPE_WITH_TEXT", obstacle: true },
    {
      id: "c",
      rect: box(200, -100, [40, 300]),
      type: "SHAPE_WITH_TEXT",
      obstacle: true,
    },
  ],
  edges: [{ id: "e", from: "a", to: "b", kind: "dep" }],
  routes: [
    {
      edge: "e",
      native: false,
      pts: [
        [100, 30],
        [400, 30],
      ],
    },
  ],
})

describe("score", () => {
  test("counts a route through a card that isn't one of its ends", () => {
    const m = score(layout())
    expect(m.edges).toBe(1)
    expect(m.throughNode).toBe(1)
    expect(m.bends).toBe(0)
    expect(m.length).toBe(300)
  })

  test("counts a crossing between unrelated routes", () => {
    const L = layout()
    L.nodes.push(
      {
        id: "d",
        rect: box(240, -300),
        type: "SHAPE_WITH_TEXT",
        obstacle: true,
      },
      { id: "f", rect: box(240, 300), type: "SHAPE_WITH_TEXT", obstacle: true },
    )
    L.edges.push({ id: "g", from: "d", to: "f", kind: "flow" })
    L.routes.push({
      edge: "g",
      native: false,
      pts: [
        [290, -240],
        [290, 300],
      ],
    })
    expect(score(L).crossings).toBe(1)
  })
})
