/**
 * The relay key lives as long as the owning Maximal process, not one plugin
 * generation: a plugin inventory or settings reload starts a new generation
 * process, which must stamp the same key so the Figma plugin already
 * imported keeps connecting.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { FIGMA_PLUGIN_DIR } from "../src/index"
import {
  FIGJAM_RELAY_KEY_ENV,
  generationRelayKey,
  initializeFigjamRelayKey,
} from "../src/relay-key"

const KEY = /^[\w-]{43}$/
const GENERATION = path.join(import.meta.dir, "fixtures", "generation.ts")

let root: string

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "figjam-relay-key-"))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function freePort(): number {
  const probe = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { data() {} },
  })
  const { port } = probe
  probe.stop(true)
  return port
}

/** Run one generation process with `env` and return the key it stamped. */
async function runGeneration(
  env: Record<string, string | undefined>,
  port: number,
): Promise<string> {
  const child = Bun.spawn(
    [
      process.execPath,
      GENERATION,
      path.join(root, "plugins"),
      path.join(root, "data"),
      String(port),
    ],
    { env, stdout: "pipe", stderr: "pipe" },
  )
  const [code, out, err] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  expect(code, `${out}${err}`).toBe(0)
  return out.trim().split("\n").at(-1) ?? ""
}

describe("relay key lifetime", () => {
  test("the owning process replaces an inherited key with a fresh one", () => {
    const env: Record<string, string | undefined> = {
      [FIGJAM_RELAY_KEY_ENV]: "inherited",
    }
    const first = initializeFigjamRelayKey(env)
    const second = initializeFigjamRelayKey(env)
    expect(first).toMatch(KEY)
    expect(second).toMatch(KEY)
    expect(second).not.toBe(first)
    expect(env[FIGJAM_RELAY_KEY_ENV]).toBe(second)
  })

  test("a generation uses the inherited key, or its own when none or a malformed one is inherited", () => {
    const env: Record<string, string | undefined> = {}
    const parent = initializeFigjamRelayKey(env)
    expect(generationRelayKey(env)).toBe(parent)
    for (const inherited of [undefined, "", "short", `${parent}x`]) {
      const own = generationRelayKey({ [FIGJAM_RELAY_KEY_ENV]: inherited })
      expect(own).toMatch(KEY)
      expect(own).not.toBe(parent)
    }
  })

  test("a reload (a new generation process) keeps the parent's key and the plugin it wrote", async () => {
    const env: Record<string, string | undefined> = { ...process.env }
    const parent = initializeFigjamRelayKey(env)
    const port = freePort()

    const first = await runGeneration(env, port)
    const uiPath = path.join(
      root,
      "plugins",
      "figjam",
      FIGMA_PLUGIN_DIR,
      "ui.html",
    )
    const written = await readFile(uiPath, "utf8")
    const second = await runGeneration(env, port)

    expect(first).toBe(parent)
    expect(second).toBe(parent)
    expect(await readFile(uiPath, "utf8")).toBe(written)
  }, 30_000)

  test("without the parent's key each generation makes its own (why the parent sets one)", async () => {
    const env: Record<string, string | undefined> = {
      ...process.env,
      [FIGJAM_RELAY_KEY_ENV]: undefined,
    }
    const port = freePort()
    const first = await runGeneration(env, port)
    const second = await runGeneration(env, port)
    expect(first).toMatch(KEY)
    expect(second).toMatch(KEY)
    expect(second).not.toBe(first)
  }, 30_000)
})
