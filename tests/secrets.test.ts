import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import fs from "node:fs"
import path from "node:path"

import { readSecret } from "~/lib/secrets"

// Repo-local fixture root (gitignored). Deliberately NOT os.tmpdir():
// CodeQL's js/insecure-temporary-file rule treats os.tmpdir() as a
// taint source and would flag the production openSync that consumes
// opts.dir, even though the production caller never touches tmp.
const TMP_ROOT = path.join(process.cwd(), ".tmp", "secrets-test")
let secretsDir: string

beforeEach(() => {
  secretsDir = path.join(TMP_ROOT, `case-${crypto.randomUUID()}`)
  fs.mkdirSync(secretsDir, { recursive: true, mode: 0o700 })
})

afterEach(() => {
  try {
    fs.rmSync(TMP_ROOT, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
})

function writeSecret(name: string, value: string, mode: number): string {
  const filePath = path.join(secretsDir, name)
  fs.writeFileSync(filePath, value, { mode })
  fs.chmodSync(filePath, mode) // explicit chmod — writeFileSync mode honors umask
  return filePath
}

describe("readSecret", () => {
  it("returns env source when env var is set, even if file exists", () => {
    writeSecret("ollama", "from-file", 0o600)
    const r = readSecret({
      envVar: "OLLAMA_API_KEY",
      fileName: "ollama",
      env: { OLLAMA_API_KEY: "from-env" },
      dir: secretsDir,
    })
    expect(r.source).toBe("env")
    expect(r.value).toBe("from-env")
  })

  it("returns file source when env is unset and file is mode 0600", () => {
    writeSecret("ollama", "secret-from-file\n", 0o600)
    const r = readSecret({
      envVar: "OLLAMA_API_KEY",
      fileName: "ollama",
      env: {},
      dir: secretsDir,
    })
    expect(r.source).toBe("file")
    expect(r.value).toBe("secret-from-file")
  })

  it("returns unset when env is empty and no file exists", () => {
    const r = readSecret({
      envVar: "OLLAMA_API_KEY",
      fileName: "ollama",
      env: {},
      dir: secretsDir,
    })
    expect(r.source).toBe("unset")
    expect(r.value).toBeUndefined()
  })

  it("refuses to load a file with mode broader than 0600", () => {
    writeSecret("ollama", "should-not-load", 0o644)
    const r = readSecret({
      envVar: "OLLAMA_API_KEY",
      fileName: "ollama",
      env: {},
      dir: secretsDir,
    })
    expect(r.source).toBe("unset")
    expect(r.value).toBeUndefined()
    expect(r.diagnostic).toContain("insecure mode")
  })

  it("treats empty file as unset", () => {
    writeSecret("ollama", "", 0o600)
    const r = readSecret({
      envVar: "OLLAMA_API_KEY",
      fileName: "ollama",
      env: {},
      dir: secretsDir,
    })
    expect(r.source).toBe("unset")
  })

  it("treats empty-string env value as unset and falls back to file", () => {
    writeSecret("ollama", "from-file", 0o600)
    const r = readSecret({
      envVar: "OLLAMA_API_KEY",
      fileName: "ollama",
      env: { OLLAMA_API_KEY: "" },
      dir: secretsDir,
    })
    expect(r.source).toBe("file")
    expect(r.value).toBe("from-file")
  })

  it("strips trailing whitespace from file contents", () => {
    writeSecret("ollama", "  spaced-and-newlined  \n\n", 0o600)
    const r = readSecret({
      envVar: "OLLAMA_API_KEY",
      fileName: "ollama",
      env: {},
      dir: secretsDir,
    })
    expect(r.value).toBe("spaced-and-newlined")
  })
})
