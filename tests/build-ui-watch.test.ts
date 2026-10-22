import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { createRebuilder, inputSignature } from "../scripts/build-ui-watch"

const root = fs.mkdtempSync(path.join(os.tmpdir(), "build-ui-watch-"))
let counter = 0

/** A fresh input tree: ui/ with a vendor file, and a single file input. */
function inputs(): { dir: string; file: string; roots: Array<string> } {
  const base = path.join(root, String(counter++))
  const dir = path.join(base, "ui")
  fs.mkdirSync(path.join(dir, "vendor"), { recursive: true })
  fs.writeFileSync(path.join(dir, "index.html"), "<p>hi</p>")
  fs.writeFileSync(path.join(dir, "vendor", "lib.js"), "window.lib = 1")
  const file = path.join(base, "splash.html")
  fs.writeFileSync(file, "splash")
  return { dir, file, roots: [dir, file] }
}

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe("inputSignature", () => {
  test("ignores timestamps, rewrites of the same bytes, copies, and dotfiles", async () => {
    const { dir, roots } = inputs()
    const before = await inputSignature(roots)
    const lib = path.join(dir, "vendor", "lib.js")
    fs.utimesSync(lib, new Date(0), new Date(0))
    fs.writeFileSync(path.join(dir, "index.html"), "<p>hi</p>")
    fs.cpSync(path.join(dir, "vendor"), path.join(root, `copy-${counter}`), {
      recursive: true,
    })
    fs.writeFileSync(path.join(dir, ".DS_Store"), "finder")
    expect(await inputSignature(roots)).toBe(before)
  })

  test("changes with contents, added and removed files, and single-file inputs", async () => {
    const { dir, file, roots } = inputs()
    const seen = new Set([await inputSignature(roots)])
    const record = async () => {
      const next = await inputSignature(roots)
      expect(seen.has(next)).toBe(false)
      seen.add(next)
    }
    fs.writeFileSync(path.join(dir, "vendor", "lib.js"), "window.lib = 2")
    await record()
    fs.writeFileSync(path.join(dir, "new.css"), "a{}")
    await record()
    fs.rmSync(path.join(dir, "new.css"))
    fs.renameSync(path.join(dir, "index.html"), path.join(dir, "main.html"))
    await record()
    fs.writeFileSync(file, "splash 2")
    await record()
  })
})

/** A rebuilder over a signature the test controls, with a build the test
 *  can hold open. */
function harness(initial = "a") {
  let current = initial
  const builds: Array<string> = []
  const errors: Array<unknown> = []
  let gate: Promise<void> | undefined
  let fail = false
  const request = createRebuilder({
    signature: () => Promise.resolve(current),
    build: async () => {
      builds.push(current)
      await gate
      if (fail) throw new Error("build failed")
    },
    built: initial,
    onError: (error) => errors.push(error),
  })
  return {
    request,
    builds,
    errors,
    set: (value: string) => {
      current = value
    },
    hold: () => {
      const { promise, resolve } = Promise.withResolvers<undefined>()
      gate = promise
      return () => {
        gate = undefined
        resolve(undefined)
      }
    },
    failNext: (value: boolean) => {
      fail = value
    },
  }
}

describe("createRebuilder", () => {
  test("doesn't rebuild when the inputs are unchanged", async () => {
    const h = harness()
    await h.request()
    await h.request()
    expect(h.builds).toEqual([])
  })

  test("rebuilds once per real change", async () => {
    const h = harness()
    h.set("b")
    await h.request()
    await h.request()
    expect(h.builds).toEqual(["b"])
  })

  test("a change during a build gets one follow-up build of the latest inputs", async () => {
    const h = harness()
    h.set("b")
    const release = h.hold()
    const first = h.request()
    await Bun.sleep(0)
    // Several events while the build runs coalesce.
    h.set("c")
    void h.request()
    h.set("d")
    void h.request()
    release()
    await first
    expect(h.builds).toEqual(["b", "d"])
  })

  test("never runs two builds at once", async () => {
    let active = 0
    let most = 0
    let current = "a"
    const request = createRebuilder({
      signature: () => Promise.resolve(current),
      build: async () => {
        active += 1
        most = Math.max(most, active)
        await Bun.sleep(5)
        active -= 1
      },
      built: "a",
      onError: () => {},
    })
    const pending: Array<Promise<void>> = []
    for (const value of ["b", "c", "d", "e"]) {
      current = value
      pending.push(request())
      await Bun.sleep(1)
    }
    await Promise.all(pending)
    await Bun.sleep(20)
    expect(most).toBe(1)
  })

  test("a failed build is reported and retried on the next request", async () => {
    const h = harness()
    h.set("b")
    h.failNext(true)
    await h.request()
    expect(h.errors).toHaveLength(1)
    h.failNext(false)
    await h.request()
    expect(h.builds).toEqual(["b", "b"])
    await h.request()
    expect(h.builds).toEqual(["b", "b"])
  })
})
