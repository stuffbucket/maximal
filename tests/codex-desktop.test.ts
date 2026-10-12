import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  chooseProviderId,
  isCodexEnabled,
  prepareCodexConfig,
  revertCodexConfig,
} from "~/apps/codex/config"
import { detectCodexDesktop } from "~/apps/codex/desktop-detect"
import { getApp } from "~/apps/registry"

const directories: Array<string> = []

afterEach(() => {
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true })
})

function fixtures(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-desktop-"))
  directories.push(directory)
  return directory
}

function bundle(directory: string, name: string): string {
  const executable = path.join(
    directory,
    name,
    "Contents",
    "Resources",
    "codex",
  )
  fs.mkdirSync(path.dirname(executable), { recursive: true })
  fs.writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 })
  return executable
}

describe("Codex Desktop detection", () => {
  test("finds both app names without needing a CLI on PATH", async () => {
    const directory = fixtures()
    bundle(directory, "Codex.app")
    bundle(directory, "ChatGPT.app")
    const installs = await detectCodexDesktop({
      platform: "darwin",
      applicationDirs: [directory],
    })
    expect(installs.map((install) => install.path)).toEqual([
      path.join(directory, "Codex.app"),
      path.join(directory, "ChatGPT.app"),
    ])
  })

  test("ignores chat-only and incomplete app bundles", async () => {
    const directory = fixtures()
    fs.mkdirSync(path.join(directory, "ChatGPT.app"))
    const executable = bundle(directory, "Codex.app")
    fs.chmodSync(executable, 0o644)
    expect(
      await detectCodexDesktop({
        platform: "darwin",
        applicationDirs: [directory],
      }),
    ).toEqual([])
  })

  test("does not advertise macOS bundles on other platforms", async () => {
    const directory = fixtures()
    bundle(directory, "Codex.app")
    expect(
      await detectCodexDesktop({
        platform: "win32",
        applicationDirs: [directory],
      }),
    ).toEqual([])
  })

  test("desktop and CLI use the same authentication identity", () => {
    expect(getApp("codex-desktop")?.name).toBe("Codex Desktop")
    expect(getApp("codex-desktop")?.apiKeyLabel).toBe("codex")
    expect(getApp("codex")?.apiKeyLabel).toBe("codex")
  })
})

describe("shared Codex routing restoration", () => {
  const original =
    '# My settings\nmodel = "test-model"\nmodel_provider = "personal"\n\n[model_providers.personal]\nname = "Personal"\nbase_url = "http://localhost:9876/v1"\n'
  const provider =
    '[model_providers."maximal-app"]\nname = "Maximal"\nbase_url = "http://127.0.0.1:4141/v1"\nwire_api = "responses"\n'

  test("enabling again from either client preserves the original restore point", () => {
    const enabled = prepareCodexConfig(original, provider, "test-model")
    expect(isCodexEnabled(enabled)).toBe(true)
    expect(chooseProviderId(enabled)).toBe("maximal-app")
    const repeated = prepareCodexConfig(enabled, provider, "test-model")
    expect(repeated).toBe(enabled)
    expect(revertCodexConfig(repeated)).toBe(original)
    expect(revertCodexConfig(original)).toBe(original)
  })

  test("disabling preserves later provider and unrelated user edits", () => {
    const enabled = prepareCodexConfig(original, provider, "test-model")
    const edited = enabled
      .replace('model_provider = "maximal-app"', 'model_provider = "personal"')
      .replace("# My settings", "# Updated settings")
    expect(revertCodexConfig(edited)).toBe(
      original.replace("# My settings", "# Updated settings"),
    )
  })

  test("review mode upgrades preserve the first restore point and later model edits", () => {
    const enabled = prepareCodexConfig(original, provider, "test-model")
    const reviewProvider =
      provider.replace("4141/v1", "4141/codex/v1")
      + "requires_openai_auth = true\n"
    const edited = enabled.replace(
      'model = "test-model"',
      'model = "new-model"',
    )
    const upgraded = prepareCodexConfig(edited, reviewProvider, "new-model")
    expect(isCodexEnabled(upgraded)).toBe(true)
    expect(upgraded).toContain("requires_openai_auth = true")
    const downgraded = prepareCodexConfig(upgraded, provider, "new-model")
    expect(revertCodexConfig(downgraded)).toBe(
      original.replace('model = "test-model"', 'model = "new-model"'),
    )
  })

  test("review mode never adopts an edited provider", () => {
    const enabled = prepareCodexConfig(original, provider, "test-model")
    const edited = enabled.replace('name = "Maximal"', 'name = "User override"')
    expect(() =>
      prepareCodexConfig(
        edited,
        provider + "requires_openai_auth = true\n",
        "test-model",
      ),
    ).toThrow("routing has changed")
  })

  test("review mode preserves user comments inside the managed block by refusing to overwrite it", () => {
    const enabled = prepareCodexConfig(original, provider, "test-model")
    const edited = enabled.replace(
      'name = "Maximal"',
      '# My provider note\nname = "Maximal"',
    )
    expect(() =>
      prepareCodexConfig(
        edited,
        provider + "requires_openai_auth = true\n",
        "test-model",
      ),
    ).toThrow("block was edited")
    expect(revertCodexConfig(edited)).toContain("# My provider note")
  })

  test("disabling preserves a managed provider still used by another profile", () => {
    const enabled = prepareCodexConfig(original, provider, "test-model")
    const edited =
      enabled + '\n[profiles.other]\nmodel_provider = "maximal-app"\n'
    const reverted = revertCodexConfig(edited)
    expect(reverted).toContain('[model_providers."maximal-app"]')
    expect(reverted).toContain(
      '[profiles.other]\nmodel_provider = "maximal-app"',
    )
    expect(reverted).not.toContain("# maximal-codex-state:")
    expect(isCodexEnabled(reverted)).toBe(false)
  })
})
