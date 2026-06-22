import { describe, expect, test } from "bun:test"

import {
  isNodeSqliteSupportedVersion,
  isSqliteRuntimeSupported,
  UnsupportedNodeSqliteRuntimeError,
} from "~/lib/sqlite"

describe("sqlite runtime support", () => {
  test("detects the minimum Node.js version for node:sqlite", () => {
    expect(isNodeSqliteSupportedVersion("22.12.0")).toBe(false)
    expect(isNodeSqliteSupportedVersion("22.13.0")).toBe(true)
    expect(isNodeSqliteSupportedVersion("23.0.0")).toBe(true)
  })

  test("disables SQLite on older Node.js versions while allowing Bun", () => {
    expect(
      isSqliteRuntimeSupported({ isBun: false, nodeVersion: "22.12.0" }),
    ).toBe(false)
    expect(
      isSqliteRuntimeSupported({ isBun: false, nodeVersion: "22.13.0" }),
    ).toBe(true)
    expect(
      isSqliteRuntimeSupported({ isBun: true, nodeVersion: "20.0.0" }),
    ).toBe(true)
  })

  test("unsupported Node.js message uses current maximal package branding", () => {
    const error = new UnsupportedNodeSqliteRuntimeError("22.12.0")

    expect(error.message).toContain(
      "`bunx --bun @stuffbucket/maximal@latest start` or `maximal start`.",
    )
    expect(error.message).not.toContain("copilot-api")
  })
})
