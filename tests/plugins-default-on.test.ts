/**
 * The decisions and SystemOne plugins start on for everyone: a boot migration
 * writes `plugins.<id>.enabled = true` where there is no choice yet, so the
 * `/v1/decisions` and `/v1/systemone` routes keep answering after the upgrade.
 * `config.json` lives under the preload's sandboxed `COPILOT_API_HOME`.
 */

import * as decisions from "@stuffbucket/maximal-plugin-decisions"
import * as systemone from "@stuffbucket/maximal-plugin-systemone"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { getConfig, writeConfig } from "~/lib/config/config"
import { PATHS } from "~/lib/platform/paths"
import { composePluginGateway } from "~/lib/plugins/compose"
import { startPlugins, stopPlugins } from "~/lib/plugins/runtime"
import {
  DEFAULT_ON_PLUGINS,
  migrateDefaultOnPlugins,
  migratePluginSettings,
  updatePluginEntry,
} from "~/lib/plugins/settings"

let storageRoot: string

beforeEach(() => {
  storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "plugins-default-on-"))
  writeConfig({})
})

afterEach(async () => {
  await stopPlugins()
  writeConfig({})
  fs.rmSync(storageRoot, { recursive: true, force: true })
})

describe("migrateDefaultOnPlugins", () => {
  test("the decisions and systemone plugins are the default-on ones", () => {
    expect([...DEFAULT_ON_PLUGINS].sort()).toEqual(["decisions", "systemone"])
  })

  test("turns both on when the config has no say", () => {
    expect(migrateDefaultOnPlugins({})?.plugins).toEqual({
      decisions: { enabled: true },
      systemone: { enabled: true },
    })
  })

  test("keeps a choice the user made, and the rest of an entry", () => {
    const migrated = migrateDefaultOnPlugins({
      plugins: {
        decisions: { enabled: false },
        systemone: { clients: [] },
        workiq: { enabled: true },
      },
    })

    expect(migrated?.plugins).toEqual({
      decisions: { enabled: false },
      systemone: { clients: [], enabled: true },
      workiq: { enabled: true },
    })
  })

  test("has nothing to do once both have a choice", () => {
    expect(
      migrateDefaultOnPlugins({
        plugins: {
          decisions: { enabled: false },
          systemone: { enabled: true },
        },
      }),
    ).toBeUndefined()
  })
})

describe("migratePluginSettings", () => {
  test("writes the defaults into config.json under the sandboxed app dir", () => {
    expect(path.dirname(PATHS.CONFIG_PATH)).toBe(
      process.env.COPILOT_API_HOME ?? "",
    )

    migratePluginSettings()

    expect(getConfig().plugins).toEqual({
      decisions: { enabled: true },
      systemone: { enabled: true },
    })
    expect(fs.readFileSync(PATHS.CONFIG_PATH, "utf8")).toContain("decisions")
  })

  test("is one-shot: a plugin the user turns off stays off at the next boot", () => {
    migratePluginSettings()
    updatePluginEntry("decisions", { enabled: false })

    migratePluginSettings()

    expect(getConfig().plugins?.decisions.enabled).toBe(false)
    expect(getConfig().plugins?.systemone.enabled).toBe(true)
  })
})

describe("startPlugins on an existing user's config", () => {
  test("serves decisions and systemone without the user touching anything", async () => {
    // A config from before the plugins existed: no `plugins` section.
    writeConfig({})

    const gateway = await startPlugins({
      gateway: composePluginGateway({
        plugins: [decisions, systemone],
        storageRoot,
      }),
    })

    const served = gateway
      ?.operations()
      .servedModels()
      .map((entry) => [entry.model, ...entry.operations])
    expect(served?.sort()).toEqual([
      ["gpt-6-luna-decisions", "decisions"],
      ["microsoft-decision-1", "systemone"],
    ])
  })
})
