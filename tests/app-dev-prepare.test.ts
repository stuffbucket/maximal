import { describe, expect, test } from "bun:test"
import path from "node:path"

import {
  devConfig,
  type PortState,
  resolveDevProfile,
  selectDevPort,
} from "../scripts/app-dev-prepare"

function probeWith(states: Record<number, PortState>) {
  const asked: Array<number> = []
  const probe = (port: number): Promise<PortState> => {
    asked.push(port)
    return Promise.resolve(states[port] ?? "free")
  }
  return { asked, probe }
}

const system = {
  platform: "linux" as const,
  homedir: "/home/tester",
}

describe("app:dev profile", () => {
  test("uses a stable isolated home for each worktree", () => {
    const first = resolveDevProfile({}, "/code/maximal-one", system)
    const again = resolveDevProfile({}, "/code/maximal-one", system)
    const other = resolveDevProfile({}, "/code/maximal-two", system)

    expect(first).toEqual(again)
    expect(
      first.home.startsWith(
        path.join("/home/tester", ".local", "share", "maximal", "dev"),
      ),
    ).toBe(true)
    expect(other.home).not.toBe(first.home)
    expect(other.identifier).not.toBe(first.identifier)
  })

  test("honors an explicit COPILOT_API_HOME", () => {
    const profile = resolveDevProfile(
      { COPILOT_API_HOME: "/tmp/my-maximal" },
      "/code/maximal",
      system,
    )

    expect(profile.home).toBe("/tmp/my-maximal")
    expect(profile.identifier).toMatch(
      /^co\.stuffbucket\.maximal\.dev\.[a-f0-9]{12}$/,
    )
  })
})

describe("app:dev port selection", () => {
  test("takes the first free development port", async () => {
    const { asked, probe } = probeWith({
      4142: "maximal",
      4143: "other",
    })

    expect(await selectDevPort(undefined, undefined, probe)).toEqual({
      port: 4144,
      replaceExisting: false,
    })
    expect(asked).toEqual([4142, 4143, 4144])
  })

  test("reuses and replaces this profile's running sidecar", async () => {
    const { asked, probe } = probeWith({ 4150: "maximal" })

    expect(await selectDevPort(undefined, 4150, probe)).toEqual({
      port: 4150,
      replaceExisting: true,
    })
    expect(asked).toEqual([4150])
  })

  test("honors an explicit port without scanning", async () => {
    const { asked, probe } = probeWith({})

    expect(await selectDevPort(5000, undefined, probe)).toEqual({
      port: 5000,
      replaceExisting: true,
    })
    expect(asked).toEqual([])
  })
})

describe("app:dev Tauri config", () => {
  test("always gives the development app its own identifier", () => {
    expect(devConfig(4141, "co.example.dev")).toEqual({
      productName: "Maximal Dev",
      identifier: "co.example.dev",
    })
  })

  test("allows webviews to use the selected loopback port", () => {
    expect(JSON.stringify(devConfig(4147, "co.example.dev"))).toContain(
      "http://127.0.0.1:4147/*",
    )
  })
})
