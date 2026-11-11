import { describe, expect, test } from "bun:test"

import { fromTree } from "../src/cli"

const bounds = (x: number, y: number, [w, h] = [200, 100]) => ({ x, y, w, h })

// A board_tree response as the bridge returns it: a page, a legend section, one family section
// with two cards and a heading, and connectors (one to a node that isn't on the page). Every node
// carries a name, as the plugin's treeNode always sends one.
const tree = {
  root: {
    id: "0:1",
    type: "PAGE",
    name: "Map",
    children: [
      {
        id: "1:1",
        type: "SECTION",
        name: "How to read this map",
        bounds: bounds(0, 2000, [800, 400]),
      },
      {
        id: "1:2",
        type: "SECTION",
        name: "Create",
        bounds: bounds(0, 0, [1200, 800]),
        style: { fill: "#EEE" },
        children: [
          {
            id: "2:1",
            type: "SHAPE_WITH_TEXT",
            name: "create_stickies",
            role: "card",
            text: "create_stickies\nIdeas",
            bounds: bounds(40, 80),
            style: { color: "lightGreen" },
          },
          {
            id: "2:2",
            type: "SHAPE_WITH_TEXT",
            name: "connect",
            role: "card",
            text: "connect",
            bounds: bounds(400, 80),
          },
          {
            id: "2:3",
            type: "TEXT",
            name: "Create",
            role: "heading",
            text: "Create",
            bounds: bounds(40, 20, [300, 40]),
          },
        ],
      },
    ],
  },
  edges: [
    {
      id: "3:1",
      from: "2:1",
      to: "2:2",
      style: { dashPattern: [10, 6], strokeWeight: 2 },
    },
    { id: "3:2", from: "2:2", to: "2:1", style: { strokeWeight: 6 } },
    { id: "3:3", from: "2:1", to: "9:9" },
  ],
}

describe("fromTree", () => {
  const L = fromTree(tree)

  test("keeps family sections and turns a legend section into a no-go block", () => {
    expect(L.sections.map((s) => s.name)).toEqual(["Create"])
    expect(L.blocks).toEqual([bounds(0, 2000, [800, 400])])
  })

  test("places nodes in their section and marks only cards as obstacles", () => {
    expect(L.nodes.map((n) => [n.id, n.section, n.obstacle])).toEqual([
      ["2:1", "1:2", true],
      ["2:2", "1:2", true],
      ["2:3", "1:2", false],
    ])
  })

  test("normalizes camelCase palette names", () => {
    expect(L.nodes[0]?.style?.color).toBe("light green")
  })

  test("drops connectors to nodes that aren't on the page and infers kinds from style", () => {
    expect(L.edges.map((e) => [e.id, e.kind])).toEqual([
      ["3:1", "flow"],
      ["3:2", "loop"],
    ])
  })

  test("takes edge kinds and labels from a reference layout when given one", () => {
    const ref = fromTree(tree)
    ref.edges = ref.edges.map((e) =>
      e.id === "3:1" ? { ...e, kind: "verify", label: "rev" } : e,
    )
    const withRef = fromTree(tree, ref)
    expect(withRef.edges[0]).toMatchObject({
      id: "3:1",
      kind: "verify",
      label: "rev",
    })
  })
})
