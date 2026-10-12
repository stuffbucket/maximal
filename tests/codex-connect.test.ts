import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { createCodexApp } from "~/apps/codex"
import { parseCatalog } from "~/apps/codex/catalog-runtime"
import { prepareCodexConfig, readCodexConfig } from "~/apps/codex/config"
import { parseConfig } from "~/apps/codex/toml"
import { getConfig, writeConfig } from "~/lib/config/config"
import { state } from "~/lib/runtime-state/state"

const initialHome = process.env.CODEX_HOME
const initialModels = state.models
let directory: string
let executable: string
let configFile: string
let codexHome: string
let verified: Array<string>
let failVerification: ((model: string) => void) | undefined
const original =
  '# User settings\nmodel = "gpt-6-luna"\napproval_policy = "on-request"\napprovals_reviewer = "user"\nsandbox_mode = "workspace-write"\n'
const bundle = {
  future_catalog_metadata: { policy: "native" },
  models: ["gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "unavailable"].map(
    (slug) => ({
      slug,
      base_instructions: `Native instructions for ${slug}`,
      future_policy: { untouched: true },
      context_window: 200000,
    }),
  ),
}

async function expectFailure(
  operation: Promise<unknown>,
  message: string,
): Promise<void> {
  let failure: unknown
  try {
    await operation
  } catch (error) {
    failure = error
  }
  expect(failure).toBeInstanceOf(Error)
  expect(String(failure)).toContain(message)
}

function saveConfig(text: string): void {
  fs.writeFileSync(configFile, text)
}
function catalog() {
  const file = parseConfig(readCodexConfig()).model_catalog_json as string
  return { file, value: parseCatalog(fs.readFileSync(file, "utf8")) }
}
function app(paths = [executable]) {
  return createCodexApp("codex", "Codex CLI and Desktop", {
    detectInstalls: () =>
      Promise.resolve(
        paths.map((file) => ({
          path: file,
          version: null,
          source: "path" as const,
        })),
      ),
    installHint: null,
    verifyProvider: (text, model) => {
      const provider = (
        parseConfig(text).model_providers as Record<
          string,
          Record<string, unknown>
        >
      )["maximal-app"]
      expect(provider.base_url).toBe("http://127.0.0.1:4141/v1")
      expect(provider.auth).toBeDefined()
      expect(provider.requires_openai_auth).toBeUndefined()
      verified.push(model)
      failVerification?.(model)
      return Promise.resolve()
    },
  })
}

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "maximal-connect-test-"))
  codexHome = path.join(directory, "home")
  process.env.CODEX_HOME = codexHome
  fs.mkdirSync(process.env.CODEX_HOME)
  configFile = path.join(process.env.CODEX_HOME, "config.toml")
  saveConfig(original)
  fs.writeFileSync(
    path.join(process.env.CODEX_HOME, "auth.json"),
    "private fixture credentials",
  )
  executable = path.join(directory, "codex")
  fs.writeFileSync(path.join(directory, "bundle.json"), JSON.stringify(bundle))
  fs.writeFileSync(
    executable,
    `#!${process.execPath}
import fs from "node:fs";
import path from "node:path";
const root = path.dirname(process.argv[1]);
const args = process.argv.slice(2);
const base = JSON.parse(fs.readFileSync(path.join(root, "bundle.json"), "utf8"));
if (fs.existsSync(path.join(process.env.CODEX_HOME, "auth.json"))) process.exit(99);
if (args.includes("--version")) console.log("codex-cli 0.157.1");
else if (args.includes("--bundled") || fs.existsSync(path.join(root, "unsupported"))) console.log(JSON.stringify(base));
else {
  const setting = args.find(arg => arg.startsWith("model_catalog_json="));
  console.log(fs.readFileSync(JSON.parse(setting.slice("model_catalog_json=".length)), "utf8"));
}
`,
    { mode: 0o755 },
  )
  verified = []
  failVerification = undefined
  state.models = {
    object: "list",
    data: bundle.models.slice(0, 3).map((model) => ({
      id: model.slug,
      supported_endpoints: ["/responses"],
    })),
  } as typeof state.models
})
afterEach(() => {
  if (initialHome === undefined) delete process.env.CODEX_HOME
  else process.env.CODEX_HOME = initialHome
  state.models = initialModels
  fs.rmSync(directory, { recursive: true, force: true })
})

describe("Connect Codex native Copilot reviews", () => {
  test("standalone CLI connect uses the running gateway's model list", async () => {
    const previousConfig = getConfig()
    writeConfig({
      ...previousConfig,
      auth: { enforce: true, apiKeys: ["fixture-local-key"] },
    })
    state.models = undefined
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        apps: [
          {
            id: "codex",
            routing: {
              available_models: ["gpt-6-luna", "gpt-6-astra", "gpt-6-sol"],
            },
          },
        ],
      }),
    )
    try {
      expect(await app().enable()).toEqual({
        success: true,
        restartRequired: true,
      })
      expect(verified).toEqual(["gpt-6-luna", "gpt-6-astra"])
      expect(catalog().value.models[2].auto_review_model_override).toBe(
        "gpt-6-astra",
      )
    } finally {
      fetchSpy.mockRestore()
      writeConfig(previousConfig)
    }
  })
  test("one connection configures every supported task entry and preserves policy/authentication", async () => {
    expect(await app().enable()).toEqual({
      success: true,
      restartRequired: true,
    })
    expect(verified).toEqual(["gpt-6-luna", "gpt-6-astra"])
    const text = readCodexConfig()
    expect(text).toContain(original)
    expect(text).not.toContain("requires_openai_auth")
    expect(text).not.toContain("/codex/v1")
    const saved = catalog()
    expect(saved.value.future_catalog_metadata).toEqual(
      bundle.future_catalog_metadata,
    )
    for (const model of saved.value.models) {
      const base = bundle.models.find((entry) => entry.slug === model.slug)
      if (!base) throw new Error("Missing test model")
      expect(model).toEqual(
        model.slug === "unavailable" ?
          base
        : { ...base, auto_review_model_override: "gpt-6-astra" },
      )
    }
    expect(fs.statSync(saved.file).mode & 0o777).toBe(0o600)
    expect(fs.readFileSync(path.join(codexHome, "auth.json"), "utf8")).toBe(
      "private fixture credentials",
    )
    expect((await app().getDetails()).routing).toMatchObject({
      automatic_review: true,
      review_update_required: false,
    })
    expect(await app().disable()).toEqual({
      success: true,
      restartRequired: true,
    })
    expect(readCodexConfig()).toBe(original)
    expect(fs.existsSync(saved.file)).toBe(true) // retained for running sessions
  })

  test("repeated connect and switching task models keep routing without new probes", async () => {
    const integration = app()
    await integration.enable()
    const first = readCodexConfig()
    expect(await integration.enable()).toEqual({
      success: true,
      restartRequired: false,
    })
    expect(readCodexConfig()).toBe(first)
    saveConfig(first.replace('model = "gpt-6-luna"', 'model = "gpt-6-sol"'))
    expect(await integration.enable()).toEqual({
      success: true,
      restartRequired: false,
    })
    expect(verified).toHaveLength(2)
    expect(
      catalog().value.models.find((model) => model.slug === "gpt-6-sol")
        ?.auto_review_model_override,
    ).toBe("gpt-6-astra")
    await integration.disable()
    expect(readCodexConfig()).toBe(original.replace("gpt-6-luna", "gpt-6-sol"))
  })

  test("copies custom metadata and restores the exact original relative catalog setting", async () => {
    const custom = {
      models: [
        {
          ...bundle.models[2],
          context_window: 12345,
          custom: { nested: [1, 2] },
          auto_review_model_override: "gpt-6-astra",
        },
      ],
      custom_root: ["keep"],
    }
    const file = path.join(codexHome, "custom.json")
    const content = JSON.stringify(custom, null, 4)
    fs.writeFileSync(file, content)
    const before =
      'model_catalog_json = "custom.json" # keep my comment\n' + original
    saveConfig(before)
    await app().enable()
    const saved = catalog().value
    expect(saved.models.find((model) => model.slug === "gpt-6-luna")).toEqual(
      custom.models[0],
    )
    expect(saved.custom_root).toEqual(["keep"])
    expect(saved.models).toHaveLength(bundle.models.length)
    expect(fs.readFileSync(file, "utf8")).toBe(content)
    await app().disable()
    expect(readCodexConfig()).toBe(before)
  })

  test("refreshes bundled metadata after an update and retains the first restore point", async () => {
    await app().enable()
    const first = catalog()
    fs.writeFileSync(
      path.join(directory, "bundle.json"),
      JSON.stringify({
        ...bundle,
        models: bundle.models.map((entry) => ({
          ...entry,
          context_window: 300000,
        })),
      }),
    )
    fs.appendFileSync(executable, "\n// new client version\n")
    expect((await app().getDetails()).routing?.review_update_required).toBe(
      true,
    )
    await app().enable()
    expect(catalog().file).not.toBe(first.file)
    expect(catalog().value.models[0].context_window).toBe(300000)
    expect(fs.readFileSync(first.file, "utf8")).toContain("200000")
    await app().disable()
    expect(readCodexConfig()).toBe(original)
  })

  test("refreshes custom-source changes without overwriting the source", async () => {
    const file = path.join(codexHome, "custom.json")
    fs.writeFileSync(file, JSON.stringify(bundle))
    saveConfig('model_catalog_json = "custom.json"\n' + original)
    await app().enable()
    const custom = { ...bundle, new_user_metadata: "preserve" }
    fs.writeFileSync(file, JSON.stringify(custom))
    expect((await app().getDetails()).routing?.review_update_required).toBe(
      true,
    )
    await app().enable()
    expect(catalog().value.new_user_metadata).toBe("preserve")
    await app().disable()
    expect(parseConfig(readCodexConfig()).model_catalog_json).toBe(
      "custom.json",
    )
  })

  test("migrates the legacy ChatGPT provider during ordinary connect", async () => {
    const provider =
      '[model_providers."maximal-app"]\nname = "Maximal"\nbase_url = "http://127.0.0.1:4141/codex/v1"\nwire_api = "responses"\nrequires_openai_auth = true\nhttp_headers = { "x-api-key" = "old-local-key" }\n'
    saveConfig(prepareCodexConfig(original, provider, "gpt-6-luna"))
    expect((await app().getDetails()).routing?.review_update_required).toBe(
      true,
    )
    await app().enable()
    expect(readCodexConfig()).not.toContain("old-local-key")
    await app().disable()
    expect(readCodexConfig()).toBe(original)
  })

  test("preserves profile selection, other profiles and manual approval settings", async () => {
    const before =
      original
      + 'profile = "work"\n[profiles.work]\nmodel = "gpt-6-sol"\nmodel_provider = "personal"\n[profiles.other]\nmodel_provider = "other"\n'
    saveConfig(before)
    await app().enable()
    expect(verified).toEqual(["gpt-6-sol", "gpt-6-astra"])
    await app().disable()
    expect(readCodexConfig()).toBe(before)
  })
})

describe("Codex catalog ownership and failures", () => {
  test("a missing managed snapshot is restored with verification and restart guidance", async () => {
    await app().enable()
    const before = readCodexConfig()
    fs.unlinkSync(catalog().file)
    expect((await app().getDetails()).routing?.review_update_required).toBe(
      true,
    )
    expect(await app().enable()).toEqual({
      success: true,
      restartRequired: true,
    })
    expect(readCodexConfig()).toBe(before)
    expect(verified).toHaveLength(4)
    expect(catalog().value.models).toHaveLength(bundle.models.length)
  })
  test("a newly available catalog task model is covered by connection refresh", async () => {
    await app().enable()
    const entry = state.models?.data[0]
    if (!entry) throw new Error("Missing model fixture")
    state.models?.data.push({ ...entry, id: "unavailable" })
    expect((await app().getDetails()).routing?.review_update_required).toBe(
      true,
    )
    await app().enable()
    expect(
      catalog().value.models.find((model) => model.slug === "unavailable")
        ?.auto_review_model_override,
    ).toBe("gpt-6-astra")
  })

  test("task models missing native metadata cannot silently lose reviewer routing", async () => {
    await app().enable()
    const entry = state.models?.data[0]
    if (!entry) throw new Error("Missing model fixture")
    state.models?.data.push({ ...entry, id: "uncatalogued" })
    const before = readCodexConfig().replace(
      'model = "gpt-6-luna"',
      'model = "uncatalogued"',
    )
    saveConfig(before)
    await expectFailure(app().enable(), "no supported Codex catalog entry")
    expect(readCodexConfig()).toBe(before)
  })

  test("all installed clients must support the catalog, including Desktop", async () => {
    const resources = path.join(directory, "Codex.app", "Contents", "Resources")
    fs.mkdirSync(resources, { recursive: true })
    fs.copyFileSync(executable, path.join(resources, "codex"))
    fs.copyFileSync(
      path.join(directory, "bundle.json"),
      path.join(resources, "bundle.json"),
    )
    fs.writeFileSync(path.join(resources, "unsupported"), "")
    await expectFailure(
      app([executable, path.join(directory, "Codex.app")]).enable(),
      "does not support",
    )
    expect(readCodexConfig()).toBe(original)
    expect(verified).toEqual([])
  })

  test("concurrent custom catalog edits are never adopted or overwritten", async () => {
    const file = path.join(codexHome, "custom.json")
    fs.writeFileSync(file, JSON.stringify(bundle))
    const before = 'model_catalog_json = "custom.json"\n' + original
    saveConfig(before)
    failVerification = () =>
      fs.writeFileSync(file, JSON.stringify({ ...bundle, user_change: true }))
    await expectFailure(app().enable(), "custom Codex catalog changed")
    expect(readCodexConfig()).toBe(before)
    expect(parseCatalog(fs.readFileSync(file, "utf8")).user_change).toBe(true)
  })

  test("preserves edited generated catalogs and their selection on disconnect", async () => {
    await app().enable()
    const saved = catalog()
    fs.appendFileSync(saved.file, "\n")
    const before = readCodexConfig()
    await expectFailure(app().enable(), "catalog was edited")
    expect(readCodexConfig()).toBe(before)
    await app().disable()
    expect(parseConfig(readCodexConfig()).model_catalog_json).toBe(saved.file)
    expect(fs.readFileSync(saved.file, "utf8")).toEndWith("\n\n")
  })

  test("preserves a user's later catalog selection on disconnect", async () => {
    await app().enable()
    const before = readCodexConfig().replace(
      /^model_catalog_json = .*$/mu,
      'model_catalog_json = "my-new-catalog.json"',
    )
    saveConfig(before)
    await expectFailure(app().enable(), "catalog selection changed")
    await app().disable()
    expect(parseConfig(readCodexConfig()).model_catalog_json).toBe(
      "my-new-catalog.json",
    )
  })
})

describe("Codex connection verification failures", () => {
  test("unsupported clients fail before provider verification or settings writes", async () => {
    fs.writeFileSync(path.join(directory, "unsupported"), "")
    await expectFailure(app().enable(), "does not support")
    expect(readCodexConfig()).toBe(original)
    expect(verified).toEqual([])
    expect(fs.existsSync(path.join(codexHome, "maximal-catalogs"))).toBe(false)
  })

  test("a failed reviewer check leaves existing working routing and catalog untouched", async () => {
    await app().enable()
    const before = readCodexConfig()
    const saved = catalog()
    fs.appendFileSync(executable, "\n// force freshness check\n")
    failVerification = (model) => {
      if (model === "gpt-6-astra") throw new Error("Reviewer failed")
    }
    await expectFailure(app().enable(), "Reviewer failed")
    expect(readCodexConfig()).toBe(before)
    expect(catalog()).toEqual(saved)
  })

  test("unavailable or disabled reviewers never switch to another model", async () => {
    const reviewer = state.models?.data[0]
    if (!reviewer) throw new Error("Missing test reviewer")
    reviewer.policy = { state: "disabled", terms: "" }
    await expectFailure(
      app().enable(),
      "Astra automatic reviewer is unavailable",
    )
    expect(readCodexConfig()).toBe(original)
    expect(verified).toEqual([])
  })

  test("concurrent configuration and source edits are rejected", async () => {
    failVerification = () =>
      saveConfig(original + "# changed during verification\n")
    await expectFailure(app().enable(), "settings changed during verification")
    expect(readCodexConfig()).toBe(original + "# changed during verification\n")
  })

  test("symlinked configuration is not replaced", async () => {
    const target = path.join(directory, "user-settings.toml")
    fs.renameSync(configFile, target)
    fs.symlinkSync(target, configFile)
    await expectFailure(app().enable(), "symlink")
    expect(fs.lstatSync(configFile).isSymbolicLink()).toBe(true)
    expect(fs.readFileSync(target, "utf8")).toBe(original)
  })
})
