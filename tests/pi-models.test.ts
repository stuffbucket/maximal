import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import type { Model, TokenPrices } from "~/services/copilot/get-models"

import { projectPiModels } from "~/apps/pi/models"
import {
  applyPiProvider,
  inspectPiProvider,
  revertPiProvider,
} from "~/apps/pi/ownership"
import { syncPiModels } from "~/apps/pi/sync"
import { currentProfileId } from "~/apps/profile-identity"

const baseUrl = "http://127.0.0.1:4141/v1"

function example(): Model {
  return {
    id: "gpt-example",
    name: "GPT Example",
    object: "model",
    vendor: "OpenAI",
    version: "1",
    model_picker_enabled: true,
    preview: false,
    supported_endpoints: ["/responses", "/chat/completions"],
    capabilities: {
      family: "gpt",
      type: "chat",
      object: "model_capabilities",
      tokenizer: "o200k_base",
      supports: {
        tool_calls: true,
        streaming: true,
        vision: true,
        reasoning_effort: ["none", "low", "high", "xhigh"],
      },
      limits: {
        max_context_window_tokens: 1_000_000,
        max_output_tokens: 128_000,
        vision: { max_prompt_images: 20 },
      },
    },
    billing: {
      token_prices: {
        batch_size: 1_000_000,
        default: {
          input_price: 200,
          output_price: 1000,
          cache_read_price: 20,
          cache_write_price: 250,
        },
      },
    },
  }
}

function projectedCost(prices: TokenPrices | undefined) {
  const model = example()
  model.billing = { token_prices: prices }
  return projectPiModels([model], baseUrl)[0]?.cost
}

describe("Pi catalog projection", () => {
  test("converts AI credits per batch into USD per million without changing API ids", () => {
    const [model] = projectPiModels([example()], baseUrl)
    expect(model).toMatchObject({
      id: "gpt-example",
      name: "GPT Example",
      api: "openai-responses",
      baseUrl,
      contextWindow: 1_000_000,
      maxTokens: 128_000,
      input: ["text", "image"],
      reasoning: true,
      cost: {
        input: 2,
        output: 10,
        cacheRead: 0.2,
        cacheWrite: 2.5,
        known: true,
      },
      thinkingLevelMap: {
        off: "none",
        minimal: null,
        low: "low",
        medium: null,
        high: "high",
        xhigh: "xhigh",
        max: null,
      },
      inputLimits: { images: { maxPerRequest: 20 } },
    })
  })

  test("scales non-million batches and honors the configured USD-per-credit conversion", () => {
    const model = example()
    model.billing = {
      token_prices: {
        batch_size: 1000,
        input: 2,
        output: 10,
        cache_read: 0.2,
        cache_write: 0,
      },
    }
    expect(projectPiModels([model], baseUrl, 0.02)[0].cost).toMatchObject({
      input: 40,
      output: 200,
      cacheRead: 4,
      cacheWrite: 0,
    })
  })

  test("keeps base pricing and adds a different long-context tier", () => {
    const model = example()
    model.billing = {
      token_prices: {
        batch_size: 1_000_000,
        preferred_tier: "long_context",
        default: {
          input_price: 200,
          output_price: 1000,
          cache_read_price: 20,
          cache_write_price: 250,
          max_prompt_tokens: 128000,
        },
        long_context: {
          input_price: 400,
          output_price: 2000,
          cache_read_price: 40,
          cache_write_price: 500,
        },
      },
    }
    expect(projectPiModels([model], baseUrl)[0].cost).toMatchObject({
      input: 2,
      output: 10,
      tiers: [
        {
          inputTokensAbove: 128000,
          input: 4,
          output: 20,
          cacheRead: 0.4,
          cacheWrite: 5,
        },
      ],
    })
  })

  test("distinguishes explicit zero prices from absent, incomplete, negative, or non-finite metadata", () => {
    expect(
      projectedCost({
        batch_size: 0,
        default: {
          input_price: 0,
          output_price: 0,
          cache_read_price: 0,
          cache_write_price: 0,
        },
      }),
    ).toMatchObject({ known: true, input: 0, output: 0 })
    expect(projectedCost(undefined)).toBeUndefined()
    expect(projectedCost({ input: 1, output: 2 })).toBeUndefined()
    for (const input of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        projectedCost({ input, output: 2, cache_read: 0, cache_write: 0 }),
      ).toBeUndefined()
    }
    expect(
      projectedCost({
        batch_size: 0,
        input: 1,
        output: 2,
        cache_read: 0,
        cache_write: 0,
      }),
    ).toBeUndefined()
    expect(() => projectPiModels([example()], baseUrl, 0)).toThrow(
      "USD per AI credit",
    )
  })

  test("uses native Anthropic transport and adaptive thinking instead of the lossy chat route", () => {
    const model = example()
    model.id = "claude-opus-5.5"
    model.name = "Claude Opus 5.5"
    model.supported_endpoints = ["/chat/completions", "/v1/messages"]
    model.capabilities.supports.adaptive_thinking = true
    expect(projectPiModels([model], baseUrl)[0]).toMatchObject({
      id: "claude-opus-5.5",
      api: "anthropic-messages",
      baseUrl: "http://127.0.0.1:4141",
      compat: { forceAdaptiveThinking: true },
    })
  })

  test("uses the declared chat endpoint with compatible token and reasoning fields", () => {
    const model = example()
    model.id = "mai-code-2-flash"
    model.name = "MAI-Code-2-Flash"
    model.supported_endpoints = ["/chat/completions"]
    expect(projectPiModels([model], baseUrl)[0]).toMatchObject({
      id: "mai-code-2-flash",
      name: "MAI Code 2 Flash",
      api: "openai-completions",
      compat: { maxTokensField: "max_tokens", supportsReasoningEffort: true },
    })
  })

  test("skips non-chat, synthetic Claude variants, missing limits, and unsupported transports", () => {
    const entries = Array.from({ length: 7 }, () => example())
    entries[0].capabilities.type = "embeddings"
    entries[1].id = "claude-opus-5.5-high"
    entries[2].supported_endpoints = []
    entries[3].capabilities.limits = {}
    entries[4].capabilities.supports.tool_calls = false
    entries[5].capabilities.supports.streaming = false
    entries[6].capabilities.limits.max_context_window_tokens = 0
    expect(projectPiModels(entries, baseUrl)).toEqual([])
  })

  test("rejects unsafe URLs and preserves a reverse proxy path prefix", () => {
    expect(() => projectPiModels([example()], "file:///tmp/config")).toThrow(
      "HTTP(S)",
    )
    expect(() =>
      projectPiModels([example()], "https://key@proxy.example/v1"),
    ).toThrow("credentials")
    expect(
      projectPiModels([example()], "https://proxy.example/maximal/v1/")[0]
        .baseUrl,
    ).toBe("https://proxy.example/maximal/v1")
  })
})

describe("Pi catalog file sync", () => {
  let directory: string
  let filePath: string
  let original: string
  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "maximal-pi-sync-"))
    filePath = path.join(directory, "models.json")
    original = JSON.stringify(
      {
        custom: "preserved",
        providers: {
          other: { apiKey: "KEEP_OTHER_KEY", models: [{ id: "other-model" }] },
          maximal: {
            baseUrl,
            apiKey: "!existing-helper",
            api: "openai-completions",
            headers: { "X-Custom": "kept" },
            modelOverrides: { "gpt-example": { maxTokens: 8192 } },
            models: [{ id: "obsolete" }],
          },
        },
      },
      null,
      2,
    )
    await writeFile(filePath, original, { mode: 0o600 })
  })
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  test("defaults to a dry run with no writes or backup files", async () => {
    const result = await syncPiModels({ filePath, catalog: [example()] })
    expect(result).toMatchObject({
      added: ["gpt-example"],
      removed: ["obsolete"],
      changed: true,
      written: false,
      backup: null,
    })
    expect(await readFile(filePath, "utf8")).toBe(original)
    expect(await readdir(directory)).toEqual(["models.json"])
  })

  test("backs up the original and replaces only models, preserving auth, overrides, and other providers", async () => {
    const result = await syncPiModels({
      filePath,
      catalog: [example()],
      write: true,
    })
    expect(result.written).toBe(true)
    if (!result.backup) throw new Error("Missing original-file backup")
    expect(await readFile(result.backup, "utf8")).toBe(original)
    expect((await stat(result.backup)).mode & 0o777).toBe(0o600)
    expect((await stat(filePath)).mode & 0o777).toBe(0o600)
    const parsed: unknown = JSON.parse(await readFile(filePath, "utf8"))
    expect(parsed).toMatchObject({
      custom: "preserved",
      providers: {
        other: { apiKey: "KEEP_OTHER_KEY", models: [{ id: "other-model" }] },
        maximal: {
          apiKey: "!existing-helper",
          api: "openai-completions",
          headers: { "X-Custom": "kept" },
          modelOverrides: { "gpt-example": { maxTokens: 8192 } },
          models: [{ id: "gpt-example", cost: { input: 2, output: 10 } }],
        },
      },
    })
    const again = await syncPiModels({
      filePath,
      catalog: [example()],
      write: true,
    })
    expect(again).toMatchObject({
      changed: false,
      written: false,
      backup: null,
    })
    expect((await readdir(directory)).length).toBe(2)
  })

  test("does not erase the working configuration after an empty upstream result", async () => {
    const failure = await syncPiModels({
      filePath,
      catalog: [],
      write: true,
    }).catch((error: unknown) => error)
    expect(String(failure)).toContain("keeping the existing list")
    expect(await readFile(filePath, "utf8")).toBe(original)
    expect(await readdir(directory)).toEqual(["models.json"])
  })

  test("refuses an absent Maximal provider without rewriting anything", async () => {
    for (const text of [
      '{ /* keep me */ "providers": {} }',
      '{"providers":{}}',
    ]) {
      await writeFile(filePath, text)
      const failure = await syncPiModels({
        filePath,
        catalog: [example()],
        write: true,
      }).catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(Error)
      expect(await readFile(filePath, "utf8")).toBe(text)
      expect(await readdir(directory)).toEqual(["models.json"])
    }
  })

  test("preserves JSONC comments while refreshing a manually configured provider", async () => {
    const text =
      '{\n // Keep this comment\n "providers":{"maximal":{"baseUrl":"http://127.0.0.1:4141/v1","apiKey":"old","models":[],}},\n "custom":true,\n}\n'
    await writeFile(filePath, text)
    const result = await syncPiModels({
      filePath,
      catalog: [example()],
      write: true,
    })
    expect(result.written).toBe(true)
    expect(await readFile(filePath, "utf8")).toContain("// Keep this comment")
    expect(await readFile(filePath, "utf8")).toContain('"custom":true')
  })

  test("refreshes the ownership fingerprint and journal of an enabled integration", async () => {
    const target = {
      filePath,
      journalPath: path.join(directory, "journal.json"),
      profileId: currentProfileId(),
    }
    applyPiProvider(
      target,
      { baseUrl, apiKey: "!helper", models: [] },
      { claim: true, adoptExisting: true },
    )
    const result = await syncPiModels({
      filePath,
      catalog: [example()],
      write: true,
      journalPath: target.journalPath,
    })
    expect(result.written).toBe(true)
    expect(inspectPiProvider(target).enabled).toBe(true)
    revertPiProvider(target)
    expect(await readFile(filePath, "utf8")).toBe(original)
  })

  test("does not change another profile's managed provider", async () => {
    const target = {
      filePath,
      journalPath: path.join(directory, "journal.json"),
      profileId: "f".repeat(64),
    }
    applyPiProvider(
      target,
      { baseUrl, models: [] },
      { claim: true, adoptExisting: true },
    )
    const text = await readFile(filePath, "utf8")
    const failure = await syncPiModels({
      filePath,
      catalog: [example()],
      write: true,
      journalPath: target.journalPath,
    }).catch((error: unknown) => error)
    expect(String(failure)).toContain("another Maximal profile")
    expect(await readFile(filePath, "utf8")).toBe(text)
  })

  test("does not replace a symlink managed by another configuration tool", async () => {
    const link = path.join(directory, "linked.json")
    await symlink(filePath, link)
    const failure = await syncPiModels({
      filePath: link,
      catalog: [example()],
      write: true,
    }).catch((error: unknown) => error)
    expect(String(failure)).toContain("regular file")
    expect(await readFile(filePath, "utf8")).toBe(original)
    expect((await readdir(directory)).length).toBe(2)
  })
})
