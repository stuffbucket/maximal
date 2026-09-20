import { describe, expect, it } from "bun:test"

import { describeExecutor, secretStatus } from "~/debug"

describe("describeExecutor", () => {
  it("picks OllamaWebExecutor when OLLAMA_API_KEY is non-empty", () => {
    expect(describeExecutor({ OLLAMA_API_KEY: "x" })).toEqual({
      web_tools: "OllamaWebExecutor",
      base: "https://ollama.com/api",
    })
  })

  it("picks InProcessFetchExecutor when OLLAMA_API_KEY is unset", () => {
    const r = describeExecutor({})
    expect(r.web_tools).toBe("InProcessFetchExecutor")
    expect(r.notes).toContain("OLLAMA_API_KEY")
  })

  it("treats empty-string OLLAMA_API_KEY as unset", () => {
    expect(describeExecutor({ OLLAMA_API_KEY: "" }).web_tools).toBe(
      "InProcessFetchExecutor",
    )
  })

  it("never includes the key value in the result", () => {
    const sentinel = "secret-sentinel-XYZ123"
    const r = describeExecutor({ OLLAMA_API_KEY: sentinel })
    expect(JSON.stringify(r)).not.toContain(sentinel)
  })
})

describe("secretStatus", () => {
  it("reports env source when env var is set, ignoring config fallback", () => {
    expect(
      secretStatus(
        { name: "k", envVar: "OLLAMA_API_KEY", configValue: "config-value" },
        {
          OLLAMA_API_KEY: "env-value",
        },
      ),
    ).toEqual({ name: "k", source: "env" })
  })

  it("falls back to config when env is unset", () => {
    expect(
      secretStatus(
        { name: "k", envVar: "OLLAMA_API_KEY", configValue: "config-value" },
        {},
      ),
    ).toEqual({
      name: "k",
      source: "config",
    })
  })

  it("reports unset when neither source has a value", () => {
    expect(
      secretStatus(
        { name: "k", envVar: "OLLAMA_API_KEY", configValue: undefined },
        {},
      ),
    ).toEqual({
      name: "k",
      source: "unset",
    })
  })

  it("treats empty-string env as unset (not env)", () => {
    expect(
      secretStatus(
        { name: "k", envVar: "OLLAMA_API_KEY", configValue: "config" },
        { OLLAMA_API_KEY: "" },
      ),
    ).toEqual({ name: "k", source: "config" })
  })

  it("never echoes the value, only the source", () => {
    const sentinel = "secret-sentinel-XYZ123"
    const r = secretStatus(
      { name: "k", envVar: "OLLAMA_API_KEY", configValue: undefined },
      { OLLAMA_API_KEY: sentinel },
    )
    expect(JSON.stringify(r)).not.toContain(sentinel)
  })
})
