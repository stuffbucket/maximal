import { describe, expect, test } from "bun:test"

import {
  MAX_INVENTORY_DEPTH,
  parsePluginInventoryDocument,
  PluginInventoryError,
  PLUGIN_INVENTORY_SCHEMA,
} from "../src/index"
const parse = (value: unknown) =>
  parsePluginInventoryDocument(value, "inventory.json")
function failure(value: unknown): PluginInventoryError {
  try {
    parse(value)
  } catch (error) {
    expect(error).toBeInstanceOf(PluginInventoryError)
    return error as PluginInventoryError
  }
  throw new Error("expected failure")
}
describe("strict inventory validation", () => {
  test("accepts the 2..32 character plugin id boundary", () => {
    const document = parse({
      $schema: PLUGIN_INVENTORY_SCHEMA,
      plugins: [
        { id: "ab", descriptorId: "descriptor" },
        {
          id: `a${"b".repeat(31)}`,
          descriptorId: "descriptor",
        },
      ],
    })
    expect(document.plugins).toHaveLength(2)
    expect(
      failure({
        $schema: PLUGIN_INVENTORY_SCHEMA,
        plugins: [
          {
            id: `a${"b".repeat(32)}`,
            descriptorId: "descriptor",
          },
        ],
      }).path,
    ).toBe("plugins[0].id")
  })
  test("rejects executable records and provenance claims in composition", () => {
    const executable = failure({
      $schema: PLUGIN_INVENTORY_SCHEMA,
      descriptors: [{ id: "bad", module: { specifier: "./evil.js" } }],
    })
    const provenance = failure({
      $schema: PLUGIN_INVENTORY_SCHEMA,
      plugins: [
        {
          id: "bad",
          descriptorId: "descriptor",
          provenance: "built-in",
        },
      ],
    })
    expect(executable.code).toBe("invalid-document")
    expect(provenance.path).toBe("plugins[0]")
  })
  test.each(["settings", "enabled"])(
    "rejects inventory-level %s because inventory selects code only",
    (field) => {
      const failureResult = failure({
        $schema: PLUGIN_INVENTORY_SCHEMA,
        plugins: [
          {
            id: "safe",
            descriptorId: "descriptor",
            [field]: field === "settings" ? { value: true } : false,
          },
        ],
      })
      expect(failureResult.code).toBe("invalid-document")
      expect(failureResult.path).toBe("plugins[0]")
    },
  )
  test("bounds nesting depth", () => {
    let nested: unknown = true
    for (let index = 0; index < MAX_INVENTORY_DEPTH + 3; index++)
      nested = [nested]
    expect(
      failure({
        $schema: PLUGIN_INVENTORY_SCHEMA,
        deeplyNestedUnknownField: nested,
      }).message,
    ).toContain("nesting depth")
  })
  test.each([
    {},
    { $schema: PLUGIN_INVENTORY_SCHEMA, unknown: true },
    {
      $schema: PLUGIN_INVENTORY_SCHEMA,
      members: [{ plugin: "safe", group: "both" }],
    },
  ])("rejects malformed strict data %#", (value) =>
    expect(failure(value).code).toBe("invalid-document"),
  )
})
