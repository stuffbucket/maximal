/**
 * The image tools through a real host with a fake upstream provider and a
 * temp output folder: registration, the first-call approval, file output
 * (paths back, never base64), the input-file checks of `edit_image` and what
 * the app core is told for the budget.
 */
import {
  capabilityServices,
  catalogModel,
  createFakeUpstream,
  createLifecycleHarness,
  type LifecycleHarness,
} from "@stuffbucket/maximal-plugin-host/testing"
import {
  type ServerToolSpend,
  type ToolResult,
} from "@stuffbucket/maximal-plugin-sdk"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { APPROVE_ACTION } from "../src/approval"
import { MAX_INPUT_BYTES } from "../src/input-files"
import { clampSize } from "../src/request"

const MODEL = "gpt-image-2.5-flare"
const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const png = (extra: Array<number> = [1, 2, 3, 4]) =>
  Buffer.from([...PNG_HEAD, ...extra])
const B64 = png([9, 9, 9, 9]).toString("base64")

const imagesReply = {
  created: 1_700_000_000,
  data: [{ b64_json: B64, revised_prompt: "a red square, flat" }],
  output_format: "png",
  usage: { input_tokens: 12, output_tokens: 272, total_tokens: 284 },
}

const handles: Array<LifecycleHarness> = []
const dirs: Array<string> = []
afterEach(async () => {
  for (const harness of handles.splice(0)) await harness.dispose()
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

function tempDir(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `images-${name}-`))
  dirs.push(dir)
  return dir
}

let out: string
let inputs: string
beforeEach(() => {
  out = tempDir("out")
  inputs = tempDir("in")
})

/** An input file in the inputs folder. */
function write(name: string, bytes: Buffer = png()): string {
  const file = path.join(inputs, name)
  fs.writeFileSync(file, bytes)
  return file
}

async function start(
  options: Parameters<typeof createFakeUpstream>[0] = {},
  config: Record<string, unknown> = {},
) {
  const fake = createFakeUpstream({
    models: [catalogModel(MODEL, "image")],
    reply: imagesReply,
    cost: () => 600_000_000,
    ...options,
  })
  const harness = createLifecycleHarness({
    plugins: [await import("../src/index")],
    extraServices: capabilityServices(fake),
  })
  handles.push(harness)
  await harness.enable("images")
  await harness.waitForStatus("images", () => true)
  await harness.setConfig("images", { outputDir: out, ...config })
  await harness.waitForStatus("images", (status) => status?.code === "ready")
  const spends: Array<ServerToolSpend> = []
  const call = (tool: string, input: Record<string, unknown>) =>
    harness.gateway.callServerTool("images", tool, input, {
      signal: new AbortController().signal,
      model: "claude-test",
      client: "claude-code",
      reportSpend: (spend) => spends.push(spend),
    })
  const approve = () => harness.runAction("images", APPROVE_ACTION)
  return { fake, harness, call, approve, spends }
}

const text = (result: ToolResult): string =>
  result.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join(",")

describe("registration", () => {
  test("hidden, always-offered tools with fixed descriptions and a declared estimate", async () => {
    const { harness } = await start()

    const tools = harness.gateway.serverTools()

    expect(tools.map((tool) => tool.name)).toEqual([
      "edit_image",
      "generate_image",
    ])
    for (const tool of tools) {
      expect(tool).toMatchObject({
        pluginId: "images",
        render: "hidden",
        offer: "always",
        clients: ["claude-code"],
      })
      // No path, count or other live state in what is sent upstream on every turn.
      expect(tool.description).not.toContain(out)
      expect(tool.estimate).toBeFunction()
    }
    const before = JSON.stringify(tools.map((tool) => tool.description))
    await harness.setConfig("images", { outputDir: inputs })
    await harness.waitForStatus("images", (status) => status?.code === "ready")
    expect(
      JSON.stringify(harness.gateway.serverTools().map((t) => t.description)),
    ).toBe(before)
  })

  test("the config turns each tool off", async () => {
    const { harness } = await start({}, { editImage: false })

    expect(harness.gateway.serverTools().map((tool) => tool.name)).toEqual([
      "generate_image",
    ])
  })

  test("the estimate names the operation, provider and what prices it", async () => {
    const { harness } = await start()
    const view = (name: string) =>
      harness.gateway.serverTools().find((tool) => tool.name === name)

    expect(view("generate_image")?.estimate?.({ prompt: "x", n: 2 })).toEqual({
      operation: "images.generations",
      provider: "copilot",
      body: { quality: "low", n: 2 },
    })
    expect(
      view("edit_image")?.estimate?.({
        prompt: "x",
        quality: "high",
        images: ["/a.png"],
      }),
    ).toEqual({
      operation: "images.edits",
      provider: "copilot",
      body: { quality: "high", n: 1 },
    })
    // Invalid input has no estimate; `execute` refuses it.
    expect(view("generate_image")?.estimate?.({ prompt: "" })).toBeUndefined()
    expect(
      view("generate_image")?.estimate?.({ prompt: "x", n: 99 }),
    ).toBeUndefined()
  })
})

describe("the first billed call", () => {
  test("waits for approval: nothing is sent or spent, and the person is asked", async () => {
    const { fake, harness, call, spends } = await start()

    const result = await call("generate_image", { prompt: "a red square" })

    expect(result.isError).toBe(true)
    expect(text(result)).toContain("have not approved")
    expect(fake.calls).toEqual([])
    expect(spends).toEqual([])
    expect(fs.readdirSync(out)).toEqual([])
    const status = harness.snapshot("images").status
    expect(status?.attention?.actions.map((action) => action.id)).toEqual([
      APPROVE_ACTION,
    ])
    expect(status?.actions?.map((action) => action.id)).toContain(
      APPROVE_ACTION,
    )
    expect(
      harness.entries.some(
        (entry) =>
          entry.kind === "event"
          && entry.type === "notice"
          && JSON.stringify(entry).includes("images-approval-requested"),
      ),
    ).toBe(true)
  })

  test("approving lets calls through, clears the request and is remembered", async () => {
    const { fake, harness, call, approve } = await start()
    await call("generate_image", { prompt: "a red square" })

    await approve()
    await harness.waitForStatus("images", (status) => !status?.attention)
    const result = await call("generate_image", { prompt: "a red square" })

    expect(result.isError).toBeUndefined()
    expect(fake.calls).toHaveLength(1)
    expect(
      harness.snapshot("images").status?.actions?.map((a) => a.id) ?? [],
    ).not.toContain(APPROVE_ACTION)
    expect(harness.files("images")).toContain("approval.json")
    // A restart (config change) keeps the approval.
    const fibers = harness.fibers("images").length
    await harness.setConfig("images", { outputDir: inputs })
    await harness.waitForStatus("images", (status) => status?.code === "ready")
    expect(harness.fibers("images").length).toBeGreaterThan(fibers)
    expect((await call("generate_image", { prompt: "again" })).isError).toBe(
      undefined,
    )
    expect(fs.readdirSync(inputs)).toHaveLength(1)
  })
})

describe("generate_image", () => {
  test("sends the defaults, saves a 0600 file and answers with its path, not the image", async () => {
    const { fake, call, approve, spends } = await start()
    await approve()

    const result = await call("generate_image", { prompt: "a red square" })

    expect(fake.calls[0].path).toBe("/v1/images/generations")
    expect(fake.calls[0].body).toEqual({
      model: MODEL,
      prompt: "a red square",
      size: "1024x1024",
      quality: "low",
      n: 1,
      output_format: "png",
    })
    const files = fs.readdirSync(out)
    expect(files).toHaveLength(1)
    expect(files[0]).toMatch(/^\d{8}-\d{6}-[0-9a-f]{8}\.png$/u)
    const file = path.join(out, files[0])
    expect(fs.readFileSync(file)).toEqual(png([9, 9, 9, 9]))
    if (process.platform !== "win32") {
      expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    }
    expect(result.isError).toBeUndefined()
    expect(text(result)).toContain(file)
    expect(text(result)).toContain("about 0.6 credits")
    expect(JSON.stringify(result)).not.toContain(B64)
    expect(result.structuredContent).toMatchObject({
      images: [{ path: file, bytes: 12, format: "png" }],
      size: "1024x1024",
      quality: "low",
      revised_prompt: "a red square, flat",
      cost_credits: 0.6,
    })
    // What the provider billed is reported to the app core, once.
    expect(spends).toHaveLength(1)
    expect(spends[0]).toMatchObject({
      operation: "images.generations",
      model: MODEL,
      provider: "copilot",
      result: {
        cost: { unit: "nano_aiu", amount: 600_000_000, estimated: false },
      },
    })
  })

  test("passes quality, size and n, clamping the size", async () => {
    const { fake, call, approve } = await start({
      reply: { ...imagesReply, data: [{ b64_json: B64 }, { b64_json: B64 }] },
    })
    await approve()

    const result = await call("generate_image", {
      prompt: "x",
      quality: "HIGH",
      size: "256x256",
      n: 2,
      output_format: "webp",
    })

    const body = fake.calls[0].body as Record<string, unknown>
    expect(body).toMatchObject({ quality: "high", n: 2, output_format: "webp" })
    expect(body.size).toBe("816x816")
    expect(fs.readdirSync(out)).toHaveLength(2)
    expect(text(result)).toContain("Saved 2 images")
  })

  test.each([
    [{ prompt: "" }, "prompt is required"],
    [{ prompt: "x", n: 5 }, "n must be a whole number from 1 to 4"],
    [{ prompt: "x", n: 1.5 }, "n must be a whole number"],
    [{ prompt: "x", quality: "ultra" }, "quality must be one of"],
    [{ prompt: "x", size: "big" }, "size must look like"],
    [{ prompt: "x", output_format: "gif" }, "output_format must be one of"],
  ])("refuses %j without calling the provider", async (input, message) => {
    const { fake, call, approve } = await start()
    await approve()

    const result = await call("generate_image", input)

    expect(result.isError).toBe(true)
    expect(text(result)).toContain(message)
    expect(fake.calls).toEqual([])
    expect(fs.readdirSync(out)).toEqual([])
  })

  test("a provider failure is an error result and spends nothing", async () => {
    const { fake, call, approve, spends } = await start()
    await approve()
    fake.enqueue(new Error("model overloaded"))

    const result = await call("generate_image", { prompt: "x" })

    expect(result.isError).toBe(true)
    expect(text(result)).toContain("model overloaded")
    expect(spends).toEqual([])
    expect(fs.readdirSync(out)).toEqual([])
  })

  test("a reply with no image is an error, but what was billed is still reported", async () => {
    const { call, approve, spends } = await start({ reply: { data: [] } })
    await approve()

    const result = await call("generate_image", { prompt: "x" })

    expect(result.isError).toBe(true)
    expect(text(result)).toContain("returned no image")
    expect(spends).toHaveLength(1)
  })

  test("a signed-out provider is a plain error", async () => {
    const { fake, call, approve } = await start()
    await approve()
    fake.setAvailable(false)

    const result = await call("generate_image", { prompt: "x" })

    expect(result.isError).toBe(true)
    expect(text(result)).toContain("Sign in")
    expect(fake.calls).toEqual([])
  })
})

describe("clampSize", () => {
  test.each([
    [undefined, "1024x1024"],
    ["auto", "1024x1024"],
    ["1024X1024", "1024x1024"],
    ["1536x1024", "1536x1024"],
    ["256x256", "816x816"],
    ["10000x10000", "2880x2880"],
    ["4000x1000", "3008x1008"],
    ["1000x1001", "1008x1008"],
  ])("%j becomes %s", (raw, expected) => {
    expect(clampSize(raw)).toBe(expected)
  })

  test("every size it returns is in the model's range", () => {
    for (const edge of [1, 15, 100, 700, 1999, 4000, 99_999]) {
      for (const other of [1, 64, 513, 3000, 99_999]) {
        const [w, h] = clampSize(`${edge}x${other}`).split("x").map(Number)
        expect(w % 16).toBe(0)
        expect(h % 16).toBe(0)
        expect(w * h).toBeGreaterThanOrEqual(655_360)
        expect(w * h).toBeLessThanOrEqual(8_294_400)
        expect(Math.max(w, h)).toBeLessThanOrEqual(3840)
        expect(Math.max(w, h) / Math.min(w, h)).toBeLessThanOrEqual(3)
      }
    }
  })
})

/** An edit that is refused with `message`, having called nothing and saved nothing. */
async function refused(images: unknown, message: string) {
  const { fake, call, approve, spends } = await start()
  await approve()
  const result = await call("edit_image", { prompt: "x", images })
  expect(result.isError).toBe(true)
  expect(text(result)).toContain(message)
  expect(fake.calls).toEqual([])
  expect(spends).toEqual([])
  expect(fs.readdirSync(out)).toEqual([])
}

describe("edit_image", () => {
  test("reads image files and sends them as a form", async () => {
    const { fake, call, approve, spends } = await start()
    await approve()
    const a = write("a.png")
    const b = write("b.JPG", Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2]))

    const result = await call("edit_image", {
      prompt: "put these in a basket",
      images: [a, b],
      quality: "medium",
    })

    expect(result.isError).toBeUndefined()
    expect(fake.calls[0].path).toBe("/v1/images/edits")
    const form = fake.calls[0].body as FormData
    expect(form).toBeInstanceOf(FormData)
    expect(form.get("model")).toBe(MODEL)
    expect(form.get("prompt")).toBe("put these in a basket")
    expect(form.get("quality")).toBe("medium")
    expect(form.get("stream")).toBeNull()
    const files = form.getAll("image[]") as Array<File>
    expect(files.map((file) => [file.name, file.type])).toEqual([
      ["a.png", "image/png"],
      ["b.JPG", "image/jpeg"],
    ])
    expect(new Uint8Array(await files[0].arrayBuffer())).toEqual(
      new Uint8Array(png()),
    )
    expect(fs.readdirSync(out)).toHaveLength(1)
    expect(spends[0]?.operation).toBe("images.edits")
    // The original is untouched.
    expect(fs.readFileSync(a)).toEqual(png())
  })

  test("a symlink inside its own folder is fine", async () => {
    const { fake, call, approve } = await start()
    await approve()
    const real = write("real.png")
    const link = path.join(inputs, "link.png")
    fs.symlinkSync(real, link)

    const result = await call("edit_image", { prompt: "x", images: [link] })

    expect(result.isError).toBeUndefined()
    expect(fake.calls).toHaveLength(1)
  })

  describe("refuses, and calls nothing, for", () => {
    let elsewhere: string
    beforeEach(() => {
      elsewhere = tempDir("else")
    })

    test("a symlink that points outside its folder, even to an image", async () => {
      const secret = path.join(elsewhere, "secret.png")
      fs.writeFileSync(secret, png())
      const link = path.join(inputs, "innocent.png")
      fs.symlinkSync(secret, link)
      await refused([link], "points outside its own folder")
    })

    test("a symlink to a non-image outside its folder", async () => {
      const key = path.join(elsewhere, "id_rsa")
      fs.writeFileSync(key, "-----BEGIN OPENSSH PRIVATE KEY-----")
      const link = path.join(inputs, "key.png")
      fs.symlinkSync(key, link)
      await refused([link], "points outside its own folder")
    })

    test("a .. in the path", async () => {
      const file = write("a.png")
      await refused(
        [
          `${inputs}${path.sep}..${path.sep}${path.basename(inputs)}${path.sep}a.png`,
        ],
        '".." are not allowed',
      )
      expect(fs.existsSync(file)).toBe(true)
    })

    test("a relative path", async () => {
      write("a.png")
      await refused(["a.png"], "give an absolute path")
    })

    test("a file that is not an image type", async () => {
      await refused([write("notes.txt", Buffer.from("hello"))], "only .png")
    })

    test("a non-image with an image extension", async () => {
      await refused(
        [write("fake.png", Buffer.from("-----BEGIN PRIVATE KEY-----"))],
        "not a PNG, JPEG or WebP image",
      )
    })

    test("a file over the size cap", async () => {
      const big = path.join(inputs, "big.png")
      fs.writeFileSync(big, png())
      fs.truncateSync(big, MAX_INPUT_BYTES + 1)
      await refused([big], "is larger than 20 MB")
    })

    test("a directory with an image name", async () => {
      const dir = path.join(inputs, "folder.png")
      fs.mkdirSync(dir)
      await refused([dir], "not a regular file")
    })

    test("a missing file", async () => {
      await refused([path.join(inputs, "nope.png")], "does not exist")
    })

    test("no images, too many images, or a bad list", async () => {
      await refused([], "1 to 4")
      await refused(
        Array.from({ length: 5 }, (_, index) => `/x/${index}.png`),
        "1 to 4",
      )
      await refused("a.png", "1 to 4")
      await refused([7], "non-empty text")
    })
  })
})
