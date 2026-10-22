import { describe, expect, it } from "bun:test"

import { describeLaunchSource, isAppBundlePath } from "~/lib/platform/cli-path"

const APP_EXEC = "/Applications/Maximal.app/Contents/MacOS/maximal"

describe("isAppBundlePath", () => {
  it("matches a .app bundle executable, nothing else", () => {
    expect(isAppBundlePath(APP_EXEC)).toBe(true)
    expect(isAppBundlePath("/opt/homebrew/bin/maximal")).toBe(false)
    expect(isAppBundlePath("/Users/x/.local/bin/maximal")).toBe(false)
  })
})

describe("describeLaunchSource", () => {
  it("classifies each install shape", () => {
    expect(describeLaunchSource(APP_EXEC).kind).toBe("dmg-app")
    expect(describeLaunchSource("/opt/homebrew/bin/maximal").kind).toBe(
      "homebrew",
    )
    expect(
      describeLaunchSource("/opt/homebrew/Cellar/maximal/0.4.25/bin/maximal")
        .kind,
    ).toBe("homebrew")
    expect(
      describeLaunchSource("/usr/local/Cellar/maximal/x/bin/maximal").kind,
    ).toBe("homebrew")
    expect(describeLaunchSource("/Users/x/.local/bin/maximal").kind).toBe(
      "user-bin",
    )
    expect(
      describeLaunchSource("/repo/shell/src-tauri/target/debug/maximal").kind,
    ).toBe("dev")
    expect(describeLaunchSource("/opt/homebrew/bin/bun").kind).toBe("dev")
    expect(describeLaunchSource("/some/random/path/maximal").kind).toBe("other")
  })

  it("returns the path verbatim", () => {
    expect(describeLaunchSource(APP_EXEC).path).toBe(APP_EXEC)
  })
})
