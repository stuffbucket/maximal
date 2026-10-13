import { describe, expect, spyOn, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  applyCodexConfigFile,
  prepareCodexConfig,
  revertCodexConfig,
  revertCodexConfigFile,
} from "~/apps/codex/config"

const invocation = {
  command: "/Applications/Maximal.app/Contents/MacOS/maximal",
  args: ["api", "codex"],
}

function rewriteOwnershipState(
  content: string,
  edit: (state: Record<string, unknown>) => void,
): string {
  const marker = "# >>> maximal codex routing v1:"
  const start = content.indexOf(marker) + marker.length
  const end = content.indexOf("\n", start)
  const state = JSON.parse(
    Buffer.from(content.slice(start, end), "base64url").toString("utf8"),
  ) as Record<string, unknown>
  edit(state)
  const encoded = Buffer.from(JSON.stringify(state), "utf8").toString(
    "base64url",
  )
  return content.slice(0, start) + encoded + content.slice(end)
}

describe("Codex config ownership", () => {
  test("apply changes only the root provider and appends one owned provider", () => {
    const original = [
      "# user settings",
      'model = "gpt-5.4" # preserve this comment',
      'model_provider = "openai"',
      'approval_policy = "on-request"',
      "",
      "[profiles.work]",
      'model_provider = "corporate"',
      'review_model = "reviewer"',
      "",
    ].join("\n")

    const result = prepareCodexConfig(original, { invocation })

    expect(result.status).toBe("changed")
    expect(result.providerId).toBe("maximal-app")
    expect(result.content).toContain(
      'model = "gpt-5.4" # preserve this comment\nmodel_provider = "maximal-app"\napproval_policy = "on-request"',
    )
    expect(result.content).toContain(
      '[profiles.work]\nmodel_provider = "corporate"\nreview_model = "reviewer"',
    )
    expect(result.content).toContain(
      '[model_providers."maximal-app"]\nname = "Maximal"\nbase_url = "http://127.0.0.1:4141/v1"\nwire_api = "responses"',
    )
    expect(result.content).toContain(
      '[model_providers."maximal-app".auth]\ncommand = "/Applications/Maximal.app/Contents/MacOS/maximal"\nargs = ["api","codex"]\ntimeout_ms = 5000\nrefresh_interval_ms = 300000',
    )
  })

  test("revert reproduces the original bytes exactly", () => {
    const original = [
      "# CRLF and spacing are user-owned\r",
      'model_provider    =    "openai" # inline\r',
      'sandbox_mode = "workspace-write"\r',
      "\r",
      "[features]\r",
      "web_search = true\r",
      "",
    ].join("\n")

    const applied = prepareCodexConfig(original, { invocation })
    expect(applied.status).toBe("changed")

    const reverted = revertCodexConfig(applied.content)
    expect(reverted).toEqual({ status: "changed", content: original })
  })

  test("reapply is a semantic no-op that preserves the first restore point", () => {
    const original = 'model_provider = "openai"\n'
    const first = prepareCodexConfig(original, { invocation })
    expect(first.status).toBe("changed")

    const second = prepareCodexConfig(first.content, { invocation })
    expect(second).toEqual({
      status: "unchanged",
      content: first.content,
      providerId: "maximal-app",
    })

    const reverted = revertCodexConfig(second.content)
    expect(reverted).toEqual({ status: "changed", content: original })
  })

  test("selects a new provider ID instead of overwriting a collision", () => {
    const original = [
      'model_provider = "openai"',
      "",
      "[model_providers.maximal-app]",
      'name = "User provider"',
      'base_url = "https://example.test/v1"',
      'wire_api = "responses"',
      "",
    ].join("\n")

    const applied = prepareCodexConfig(original, { invocation })

    expect(applied.providerId).toBe("maximal-app-2")
    expect(applied.content).toContain('[model_providers."maximal-app-2"]')
    expect(applied.content).toContain(
      '[model_providers.maximal-app]\nname = "User provider"\nbase_url = "https://example.test/v1"',
    )
    expect(revertCodexConfig(applied.content).content).toBe(original)
  })

  test("reserves provider IDs referenced by profiles", () => {
    const original = [
      'model_provider = "openai"',
      "",
      "[profiles.work]",
      'model_provider = "maximal-app"',
      "",
    ].join("\n")

    const applied = prepareCodexConfig(original, { invocation })

    expect(applied.providerId).toBe("maximal-app-2")
    expect(applied.content).toContain('[model_providers."maximal-app-2"]')
    expect(revertCodexConfig(applied.content).content).toBe(original)
  })

  test("revert preserves a root selector changed after apply", () => {
    const original = [
      'model_provider = "openai"',
      'approval_policy = "on-request"',
      "",
    ].join("\n")
    const applied = prepareCodexConfig(original, { invocation })
    const edited = applied.content.replace(
      'model_provider = "maximal-app"',
      'model_provider = "corporate"',
    )

    const reverted = revertCodexConfig(edited)

    expect(reverted).toEqual({
      status: "cleanup-required",
      content: edited,
      reasons: ["selector-modified"],
    })
  })

  test("revert preserves simultaneous selector and provider drift", () => {
    const original = 'model_provider = "openai"\n'
    const applied = prepareCodexConfig(original, { invocation })
    const edited = applied.content
      .replace('model_provider = "maximal-app"', 'model_provider = "corporate"')
      .replace('name = "Maximal"', 'name = "Customized Maximal"')

    expect(revertCodexConfig(edited)).toEqual({
      status: "cleanup-required",
      content: edited,
      reasons: ["selector-modified", "provider-modified"],
    })
  })

  test("revert retains a provider referenced by a profile added after apply", () => {
    const original = 'model_provider = "openai"\n'
    const applied = prepareCodexConfig(original, { invocation })
    const edited = `${applied.content}\n\n[profiles.later]\nmodel_provider = "maximal-app"\n`

    const reverted = revertCodexConfig(edited)

    expect(reverted.status).toBe("cleanup-required")
    expect(reverted.content).toStartWith(original)
    expect(reverted.content).toContain(
      '[profiles.later]\nmodel_provider = "maximal-app"',
    )
    expect(reverted.content).toContain('[model_providers."maximal-app"]')
    expect(reverted.content).not.toContain("maximal codex routing")
    if (reverted.status === "cleanup-required") {
      expect(reverted.reasons).toEqual(["provider-modified"])
    }
  })

  test("revert retains a provider table changed after apply", () => {
    const original = 'model_provider = "openai"\n'
    const applied = prepareCodexConfig(original, { invocation })
    const edited = applied.content.replace(
      'name = "Maximal"',
      'name = "Customized Maximal"',
    )

    const reverted = revertCodexConfig(edited)

    expect(reverted.status).toBe("cleanup-required")
    expect(reverted.content).toStartWith(original)
    expect(reverted.content).toContain('name = "Customized Maximal"')
    expect(reverted.content).toContain('[model_providers."maximal-app"]')
    expect(reverted.content).not.toContain("maximal codex routing")
    if (reverted.status === "cleanup-required") {
      expect(reverted.reasons).toEqual(["provider-modified"])
    }
  })

  test.each([
    ["empty config", ""],
    [
      "config without a root provider",
      [
        'model = "gpt-5.4"',
        "",
        "[profiles.work]",
        'model = "gpt-5.4"',
        "",
      ].join("\n"),
    ],
  ])("initializes an absent root provider in an %s", (_label, original) => {
    const applied = prepareCodexConfig(original, { invocation })

    expect(applied.status).toBe("changed")
    expect(applied.content.startsWith('model_provider = "maximal-app"\n')).toBe(
      true,
    )
    expect(revertCodexConfig(applied.content)).toEqual({
      status: "changed",
      content: original,
    })
  })
})

describe("Codex config ownership conflicts", () => {
  const beginMarker = "# >>> maximal codex routing v1:"
  const endMarker = "# <<< maximal codex routing"

  test("finds only an anchored root selector before real table headers", () => {
    const original = [
      '# model_provider = "comment-only"',
      'notice = "contains [ but is not a table"',
      'model_provider = "openai"',
      "",
      "   [profiles.work]",
      'model_provider = "corporate"',
      "",
    ].join("\n")

    const applied = prepareCodexConfig(original, { invocation })
    expect(applied.content).toContain(
      '# model_provider = "comment-only"\nnotice = "contains [ but is not a table"\nmodel_provider = "maximal-app"',
    )
    expect(applied.content).toContain(
      '   [profiles.work]\nmodel_provider = "corporate"',
    )
    expect(revertCodexConfig(applied.content).content).toBe(original)
  })

  test("fails closed on an unsupported multiline root selector", () => {
    expect(() =>
      prepareCodexConfig('model_provider = """openai"""\n', { invocation }),
    ).toThrow("Cannot safely edit malformed Codex config")
  })

  test("fails closed on malformed TOML", () => {
    expect(() =>
      prepareCodexConfig('model_provider = "unterminated\n', { invocation }),
    ).toThrow("Cannot safely edit malformed Codex config")
  })

  test("rejects duplicate and incomplete ownership markers", () => {
    const applied = prepareCodexConfig('model_provider = "openai"\n', {
      invocation,
    }).content
    const beginLine = applied
      .split("\n")
      .find((line) => line.startsWith(beginMarker))
    expect(beginLine).toBeDefined()

    expect(() => revertCodexConfig(`${applied}\n${beginLine}`)).toThrow(
      "ownership markers are duplicated",
    )
    expect(() => revertCodexConfig(applied.replace(endMarker, ""))).toThrow(
      "ownership block is incomplete",
    )
    expect(() => revertCodexConfig(`${applied}\n${endMarker}`)).toThrow(
      "ownership block is incomplete",
    )
  })

  test("rejects invalid ownership metadata", () => {
    const applied = prepareCodexConfig('model_provider = "openai"\n', {
      invocation,
    }).content
    const corrupted = applied.replace(
      new RegExp(`(?<=${beginMarker})[^\\r\\n]+`, "u"),
      "not-valid-base64",
    )

    expect(() => revertCodexConfig(corrupted)).toThrow(
      "Codex ownership metadata is invalid",
    )
  })

  test.each([
    ["version", 2],
    ["providerId", 42],
    ["priorSelectorToken", 42],
    ["insertedSelector", 42],
    ["createdFile", "yes"],
    ["appendPrefix", 42],
    ["fingerprint", 42],
  ])("rejects forged %s ownership metadata", (field, value) => {
    const applied = prepareCodexConfig('model_provider = "openai"\n', {
      invocation,
    }).content
    const forged = rewriteOwnershipState(applied, (state) => {
      state[field] = value
    })

    expect(() => revertCodexConfig(forged)).toThrow(
      "Codex ownership metadata is invalid",
    )
  })

  test("rejects an owned block whose append boundary moved", () => {
    const applied = prepareCodexConfig('model_provider = "openai"', {
      invocation,
    }).content
    const moved = applied.replace(`\n\n${beginMarker}`, `\n${beginMarker}`)

    expect(() => revertCodexConfig(moved)).toThrow(
      "Codex ownership block moved or changed",
    )
  })

  test("revert removes a semantically owned inserted selector after reformatting", () => {
    const applied = prepareCodexConfig("", { invocation }).content
    const reformatted = applied.replace(
      'model_provider = "maximal-app"',
      "model_provider='maximal-app'",
    )

    expect(revertCodexConfig(reformatted)).toEqual({
      status: "changed",
      content: "",
    })
  })

  test("reapply rejects selector and provider drift", () => {
    const applied = prepareCodexConfig('model_provider = "openai"\n', {
      invocation,
    }).content

    expect(() =>
      prepareCodexConfig(
        applied.replace(
          'model_provider = "maximal-app"',
          'model_provider = "corporate"',
        ),
        { invocation },
      ),
    ).toThrow("Codex routing owned by Maximal has been modified")
    expect(() =>
      prepareCodexConfig(
        applied.replace('name = "Maximal"', 'name = "Other"'),
        {
          invocation,
        },
      ),
    ).toThrow("Codex routing owned by Maximal has been modified")
  })

  test("reapply refreshes an owned Maximal invocation and preserves restore state", () => {
    const original = 'model_provider = "openai"\n'
    const applied = prepareCodexConfig(original, { invocation }).content
    const refreshed = prepareCodexConfig(applied, {
      invocation: { ...invocation, command: "/different/maximal" },
    })

    expect(refreshed.status).toBe("changed")
    expect(refreshed.providerId).toBe("maximal-app")
    expect(refreshed.content).toContain('command = "/different/maximal"')
    expect(refreshed.content).not.toContain(
      'command = "/Applications/Maximal.app/Contents/MacOS/maximal"',
    )
    expect(revertCodexConfig(refreshed.content)).toEqual({
      status: "changed",
      content: original,
    })
  })

  test("skips every provider ID already defined or referenced", () => {
    const original = [
      'model_provider = "openai"',
      "",
      "[model_providers.maximal-app]",
      'name = "existing"',
      "",
      "[[profiles]]",
      'model_provider = "maximal-app-2"',
      "",
    ].join("\n")

    const applied = prepareCodexConfig(original, { invocation })
    expect(applied.providerId).toBe("maximal-app-3")
    expect(revertCodexConfig(applied.content).content).toBe(original)
  })
})

describe("Codex config file writes", () => {
  test("apply and revert write privately and repeated operations are no-ops", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "maximal-codex-"))
    const file = path.join(directory, "config.toml")
    const original = 'model_provider = "openai"\n'
    try {
      fs.writeFileSync(file, original, { mode: 0o644 })

      const applied = applyCodexConfigFile(file, { invocation })
      expect(applied).toMatchObject({ wrote: true, providerId: "maximal-app" })
      expect(fs.statSync(file).mode & 0o777).toBe(0o600)
      const appliedMtime = fs.statSync(file).mtimeMs

      expect(applyCodexConfigFile(file, { invocation })).toMatchObject({
        wrote: false,
        providerId: "maximal-app",
      })
      expect(fs.statSync(file).mtimeMs).toBe(appliedMtime)

      expect(revertCodexConfigFile(file)).toMatchObject({
        wrote: true,
        status: "changed",
      })
      expect(fs.readFileSync(file, "utf8")).toBe(original)
      expect(revertCodexConfigFile(file)).toMatchObject({
        wrote: false,
        status: "unchanged",
      })
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  test("revert preserves an existing empty config file", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "maximal-codex-"))
    const file = path.join(directory, "config.toml")
    try {
      fs.writeFileSync(file, "")
      expect(applyCodexConfigFile(file, { invocation }).wrote).toBe(true)

      expect(revertCodexConfigFile(file)).toMatchObject({
        wrote: true,
        status: "changed",
        content: "",
      })
      expect(fs.existsSync(file)).toBe(true)
      expect(fs.readFileSync(file, "utf8")).toBe("")
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  test("revert tolerates unsupported parent-directory fsync after removal", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "maximal-codex-"))
    const file = path.join(directory, "config.toml")
    try {
      expect(applyCodexConfigFile(file, { invocation }).wrote).toBe(true)
      const originalOpenSync = fs.openSync
      const unsupported = Object.assign(
        new Error("directory fsync unsupported"),
        {
          code: "EINVAL",
        },
      )
      const openSpy = spyOn(fs, "openSync").mockImplementation(
        (target, flags, mode) => {
          if (target === directory) throw unsupported
          return originalOpenSync(target, flags, mode)
        },
      )

      try {
        expect(revertCodexConfigFile(file)).toMatchObject({
          wrote: true,
          status: "changed",
        })
      } finally {
        openSpy.mockRestore()
      }
      expect(fs.existsSync(file)).toBe(false)
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  test("revert removes a config file created by apply", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "maximal-codex-"))
    const file = path.join(directory, "config.toml")
    try {
      expect(applyCodexConfigFile(file, { invocation }).wrote).toBe(true)
      expect(fs.existsSync(file)).toBe(true)
      const originalFsyncSync = fs.fsyncSync
      const fsynced: Array<number> = []
      const fsyncSpy = spyOn(fs, "fsyncSync").mockImplementation((fd) => {
        fsynced.push(fd)
        originalFsyncSync(fd)
      })

      try {
        expect(revertCodexConfigFile(file)).toMatchObject({
          wrote: true,
          status: "changed",
        })
      } finally {
        fsyncSpy.mockRestore()
      }
      expect(fsynced).toHaveLength(1)
      expect(fs.existsSync(file)).toBe(false)
      expect(revertCodexConfigFile(file)).toEqual({
        status: "unchanged",
        content: "",
        path: file,
        wrote: false,
      })
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  test("refuses to remove a created config changed during revert", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "maximal-codex-"))
    const file = path.join(directory, "config.toml")
    try {
      expect(applyCodexConfigFile(file, { invocation }).wrote).toBe(true)
      const originalReadFileSync = fs.readFileSync
      const originalWriteFileSync = fs.writeFileSync
      let reads = 0
      const racingReadFileSync = ((
        target: fs.PathOrFileDescriptor,
        options?: BufferEncoding,
      ) => {
        if (target === file && reads++ === 1) {
          originalWriteFileSync(file, "changed concurrently")
        }
        return originalReadFileSync(target, options)
      }) as typeof fs.readFileSync
      const readSpy = spyOn(fs, "readFileSync").mockImplementation(
        racingReadFileSync,
      )

      try {
        expect(() => revertCodexConfigFile(file)).toThrow(
          "Codex config changed before it could be removed",
        )
      } finally {
        readSpy.mockRestore()
      }
      expect(fs.readFileSync(file, "utf8")).toBe("changed concurrently")
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  test("refuses to write through a symlinked config directory", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "maximal-codex-"))
    const realHome = path.join(directory, "real-home")
    const linkedHome = path.join(directory, "linked-home")
    const file = path.join(linkedHome, "config.toml")
    try {
      fs.mkdirSync(realHome)
      fs.symlinkSync(realHome, linkedHome)

      expect(() => applyCodexConfigFile(file, { invocation })).toThrow(
        "symbolic link",
      )
      expect(fs.existsSync(path.join(realHome, "config.toml"))).toBe(false)
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  test("refuses to follow a Codex config symlink", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "maximal-codex-"))
    const file = path.join(directory, "config.toml")
    const victim = path.join(directory, "victim.toml")
    try {
      fs.writeFileSync(victim, 'model_provider = "openai"\n')
      fs.symlinkSync(victim, file)

      expect(() => applyCodexConfigFile(file, { invocation })).toThrow(
        "symbolic link",
      )
      expect(fs.readFileSync(victim, "utf8")).toBe(
        'model_provider = "openai"\n',
      )
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })
})
