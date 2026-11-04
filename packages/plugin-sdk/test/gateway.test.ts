import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

import { isPluginGatewayError, PluginGatewayError } from "../src/gateway"

function source(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8")
}

/** Import/export specifiers that are not type-only. */
function runtimeSpecifiers(text: string): Array<string> {
  const statements =
    text.match(/^(?:import|export)\b[^;]+?from\s+["'][^"']+["']/gm) ?? []
  return statements
    .filter((statement) => !/^(?:import|export)\s+type\b/.test(statement))
    .map((statement) => /from\s+["']([^"']+)["']/.exec(statement)?.[1] ?? "")
}

describe("gateway seam", () => {
  test("gateway.ts has no runtime imports", () => {
    expect(runtimeSpecifiers(source("../src/gateway.ts"))).toEqual([])
  })

  test("types.ts and errors.ts never reference cordis", () => {
    expect(source("../src/types.ts")).not.toMatch(
      /from\s+["']@deepseek-ai\/cordis/,
    )
    expect(source("../src/errors.ts")).not.toMatch(
      /from\s+["']@deepseek-ai\/cordis/,
    )
    expect(runtimeSpecifiers(source("../src/types.ts"))).toEqual([])
    expect(runtimeSpecifiers(source("../src/errors.ts"))).toEqual([])
  })

  test("PluginGatewayError carries code and plugin id", () => {
    const error = new PluginGatewayError(
      "unknown-tool",
      "workiq",
      "no such tool",
    )
    expect(error.code).toBe("unknown-tool")
    expect(error.pluginId).toBe("workiq")
    expect(isPluginGatewayError(error)).toBe(true)
    const lookalike = Object.assign(new Error("x"), {
      name: "PluginGatewayError",
      code: "plugin-inactive",
    })
    expect(isPluginGatewayError(lookalike)).toBe(true)
    expect(isPluginGatewayError(new Error("x"))).toBe(false)
  })
})
