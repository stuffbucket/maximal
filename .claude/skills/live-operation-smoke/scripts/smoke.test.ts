import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

import { resolveWorktreeId } from "../../../../scripts/app-dev-prepare"
import { parseArgs, plannedImageCredits } from "./options"
import {
  answerEvidence,
  decodePng,
  hasValidAnswers,
} from "./response-validation"
import { AmbiguousPostError, post, smokeErrorExitCode } from "./smoke"

const temporaryDirectories: Array<string> = []
const originalFetch = globalThis.fetch

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error("Expected the promise to reject.")
}

function temporaryRepo(): string {
  const repo = mkdtempSync(path.join(os.tmpdir(), "maximal-live-smoke-"))
  temporaryDirectories.push(repo)
  const result = Bun.spawnSync({
    cmd: ["git", "init", "--quiet"],
    cwd: repo,
    stderr: "pipe",
  })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  return repo
}

afterEach(() => {
  globalThis.fetch = originalFetch
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe("live operation smoke arguments", () => {
  test("preflight accepts an explicit base URL", () => {
    const parsed = parseArgs(["--base-url", "http://127.0.0.1:64792"], {})

    expect(parsed.baseUrl.origin).toBe("http://127.0.0.1:64792")
    expect(parsed.operations).toEqual([])
  })

  test("discovers the running app:dev URL for the current worktree", () => {
    const repo = temporaryRepo()
    const worktreeId = resolveWorktreeId(repo, () => "a1b2c3d4e5f6")
    const home = path.join(repo, "dev-home")
    mkdirSync(home)
    writeFileSync(
      path.join(home, "session-running"),
      JSON.stringify({
        version: 2,
        pid: process.pid,
        port: 49_321,
        instanceId: `co.stuffbucket.maximal.dev.maximal-${worktreeId}`,
      }),
    )

    const parsed = parseArgs([], { COPILOT_API_HOME: "dev-home" }, repo)

    expect(parsed.baseUrl.origin).toBe("http://127.0.0.1:49321")
  })

  test("refuses conflicting explicit targets", () => {
    expect(() =>
      parseArgs(["--base-url", "http://127.0.0.1:4141"], {
        MAXIMAL_BASE_URL: "http://127.0.0.1:4242",
      }),
    ).toThrow("Ambiguous target")
  })

  test("refuses when this worktree has no running app:dev instance", () => {
    expect(() => parseArgs([], {}, temporaryRepo())).toThrow(
      "No running app:dev instance",
    )
  })

  test("live operations require confirmation", () => {
    expect(() =>
      parseArgs(
        ["--base-url", "http://127.0.0.1:64792", "--operations", "decisions"],
        {},
      ),
    ).toThrow("--confirm-live")
  })

  test("classifies a truncated paid POST response as ambiguous", async () => {
    globalThis.fetch = Object.assign(
      () =>
        Promise.resolve(
          new Response('{"incomplete"', {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        ),
      { preconnect: originalFetch.preconnect },
    )
    const options = parseArgs(["--base-url", "http://127.0.0.1:64792"], {})

    const error = await rejection(
      post(options, {
        pathname: "/v1/decisions",
        body: "{}",
        contentType: "application/json",
      }),
    )

    expect(error).toBeInstanceOf(AmbiguousPostError)
    expect(smokeErrorExitCode(error)).toBe(3)
  })

  test("image edit requires generation and the exact spend acknowledgements", () => {
    expect(() =>
      parseArgs(
        [
          "--base-url",
          "http://127.0.0.1:64792",
          "--operations",
          "images.edit",
          "--confirm-live",
          "--allow-image-spend",
          "--max-planned-image-credits",
          "1.4",
          "--out-dir",
          "/tmp/smoke",
        ],
        {},
      ),
    ).toThrow("requires images.generate")

    expect(() =>
      parseArgs(
        [
          "--base-url",
          "http://127.0.0.1:64792",
          "--operations",
          "images.generate,images.edit",
          "--confirm-live",
          "--allow-image-spend",
          "--max-planned-image-credits",
          "1.9",
          "--out-dir",
          "/tmp/smoke",
        ],
        {},
      ),
    ).toThrow("above the acknowledged")
  })

  test("rejects image edit before its generated fixture", () => {
    expect(() =>
      parseArgs(
        [
          "--base-url",
          "http://127.0.0.1:64792",
          "--operations",
          "images.edit,images.generate",
          "--confirm-live",
          "--allow-image-spend",
          "--max-planned-image-credits",
          "2",
          "--out-dir",
          "/tmp/smoke",
        ],
        {},
      ),
    ).toThrow("images.generate must appear before images.edit")
  })

  test("the fixed full image plan is two credits", () => {
    expect(plannedImageCredits(["images.generate", "images.edit"])).toBe(2)
  })

  test("remote targets need explicit transport acknowledgements", () => {
    expect(() => parseArgs(["--base-url", "https://example.test"], {})).toThrow(
      "--allow-remote",
    )
    expect(() =>
      parseArgs(["--base-url", "http://example.test", "--allow-remote"], {}),
    ).toThrow("--allow-insecure-http")
  })

  test("client credentials come only from the environment", () => {
    const parsed = parseArgs(["--base-url", "http://localhost:4141"], {
      MAXIMAL_API_KEY: "secret",
    })

    expect(parsed.apiKey).toBe("secret")
    expect(() =>
      parseArgs(
        ["--base-url", "http://localhost:4141", "--api-key", "secret"],
        {},
      ),
    ).toThrow("Unknown argument")
  })

  test("validates the requested Decisions answer rather than any answer", () => {
    const body = {
      answers: [
        { type: "predicate", name: "marker_present", probability: 0.99 },
      ],
    }

    expect(hasValidAnswers("decisions", body)).toBe(true)
    expect(answerEvidence("decisions", body)).toEqual({
      type: "predicate",
      name: "marker_present",
      probability: 0.99,
    })
    expect(
      hasValidAnswers("decisions", {
        answers: [{ type: "refusal", name: "marker_present" }],
      }),
    ).toBe(false)
  })

  test("validates the requested SystemOne answer rather than any answer", () => {
    const body = {
      answers: { marker_present: { type: "noul", noul: 0.001 } },
    }

    expect(hasValidAnswers("systemone", body)).toBe(true)
    expect(answerEvidence("systemone", body)).toEqual({
      type: "noul",
      name: "marker_present",
      noul: 0.001,
    })
    expect(
      hasValidAnswers("systemone", {
        answers: { wrong: { type: "noul", noul: 0.001 } },
      }),
    ).toBe(false)
  })

  test("requires exactly one PNG image response", () => {
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1])
    const image = { b64_json: png.toString("base64") }

    expect(decodePng({ data: [image] })).toEqual(png)
    expect(() => decodePng({ data: [image, image] })).toThrow("expected 1")
  })
})
